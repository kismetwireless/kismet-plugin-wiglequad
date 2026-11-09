// WiGLE WWWD quad, for the Kismet web UI: the quad you're driving, drawn on
// the map, with a sound when you leave it (repeated while you're out) and
// another when you come back.  A device rule on the server tags the Wi-Fi
// access points, Bluetooth devices and cell towers seen inside the quad and
// collects them in a view, which the map draws.
//
// The quad is kept in the rule, in a block of the server's API rules that
// this plugin owns, so every browser on the server sees the same quad.  The
// browser keeps a copy, and puts the rule back if the server lost it (API
// rules only last across restarts with device_rules_api_save=true).  Sounds
// are this browser's own, kept in IndexedDB.

const ruleName = 'wiglequad';
const blockBegin = '# wiglequad begin';
const blockEnd = '# wiglequad end';
const tag = 'WWWD quad';
const viewTitle = 'Devices in the WWWD quad';
const viewId = `rule-${ruleName}`;
// What the WWWD counts
const kinds = '(phy == "IEEE802.11" and type == "Wi-Fi AP" or phy in ["Bluetooth", "BTLE", "Cellular"])';
const kindText = 'Wi-Fi access points, Bluetooth devices and cell towers';

const maxSoundBytes = 2 * 1024 * 1024;
const repeatChoices = [5, 10, 20, 30, 60];

export function register(kismet) {
    const { ui, api, settings, eventbus, dom, icons, format } = kismet;
    const { el } = dom;
    const { dialog } = kismet.widgets.dialog;

    document.head.append(el('link', { rel: 'stylesheet', href: new URL('../css/wiglequad.ui2.css', import.meta.url).href }));

    // { s, n, w, e } or null
    let quad = cleanQuad(settings.get('wiglequad.quad', null));
    // [lon, lat] of the GPS fix, or null without one
    let here = null;
    let inside = null;
    let lastExitSound = 0;
    let soundNote = '';
    let serverNote = '';
    const listeners = new Set();
    const changed = () => listeners.forEach((fn) => fn());

    function cleanQuad(q) {
        if (!q || typeof q !== 'object')
            return null;
        const v = [q.s, q.n, q.w, q.e].map(Number);
        if (!v.every(Number.isFinite) || v[0] >= v[1] || v[2] >= v[3] ||
                Math.abs(v[0]) > 90 || Math.abs(v[1]) > 90 || Math.abs(v[2]) > 180 || Math.abs(v[3]) > 180)
            return null;
        return { s: v[0], n: v[1], w: v[2], e: v[3] };
    }

    const sameQuad = (a, b) => (!a && !b) || (!!a && !!b && a.s === b.s && a.n === b.n && a.w === b.w && a.e === b.e);

    function within(p) {
        return !!quad && !!p && p[1] >= quad.s && p[1] <= quad.n && p[0] >= quad.w && p[0] <= quad.e;
    }

    // Numbers as the rule language writes them: no exponents
    const num = (v) => {
        const t = v.toFixed(7).replace(/\.?0+$/, '');
        return t === '-0' ? '0' : t;
    };

    function ruleBlock(q) {
        return [
            blockBegin,
            '# Written by the WWWD quad plugin; edit the quad in its window, changes here are replaced',
            `rule ${ruleName} {`,
            `    description "${viewTitle}"`,
            `    when ${kinds} and lat(location) >= ${num(q.s)} and lat(location) <= ${num(q.n)} and ` +
                `lon(location) >= ${num(q.w)} and lon(location) <= ${num(q.e)}`,
            `    tag "${tag}"`,
            `    view "${viewTitle}"`,
            '}',
            blockEnd,
        ].join('\n');
    }

    // The API rules split around our block: { before, block, after }
    function splitRules(text) {
        const lines = String(text ?? '').split('\n');
        const b = lines.indexOf(blockBegin);
        const e = b < 0 ? -1 : lines.indexOf(blockEnd, b);
        if (b < 0 || e < 0)
            return { before: lines.join('\n'), block: null, after: '' };
        return { before: lines.slice(0, b).join('\n'), block: lines.slice(b, e + 1).join('\n'),
            after: lines.slice(e + 1).join('\n') };
    }

    function quadOf(block) {
        const n = '(-?[0-9]+(?:\\.[0-9]+)?)';
        const m = new RegExp(`lat\\(location\\) >= ${n} and lat\\(location\\) <= ${n} and ` +
            `lon\\(location\\) >= ${n} and lon\\(location\\) <= ${n}`).exec(block ?? '');
        return m ? cleanQuad({ s: m[1], n: m[2], w: m[3], e: m[4] }) : null;
    }

    async function serverRules() {
        const r = await api.get('devices/rules/rules.json');
        return String(r?.['kismet.devicerules.api_rules'] ?? '');
    }

    // Replace our block in the server's API rules, keeping everyone else's
    async function writeRule(q) {
        const { before, after } = splitRules(await serverRules());
        const parts = [before.replace(/\n+$/, ''), q ? ruleBlock(q) : '', after.replace(/^\n+/, '')].filter(Boolean);
        const text = parts.length ? `${parts.join('\n')}\n` : '';
        const reply = JSON.parse(await api.command('devices/rules/set.cmd', { rules: text }));
        if (!reply?.ok)
            throw new Error(reply?.error ?? 'the server refused the rule');
        return reply;
    }

    // The server's quad wins; without one there, put ours back
    let syncing = null;

    function syncServer() {
        syncing ??= syncOnce().finally(() => { syncing = null; });
        return syncing;
    }

    async function syncOnce() {
        try {
            const block = splitRules(await serverRules()).block;
            const theirs = block ? quadOf(block) : null;
            if (theirs) {
                if (!sameQuad(theirs, quad))
                    setQuad(theirs, false);
                // A rule from an older version of the plugin
                if (block !== ruleBlock(theirs))
                    await writeRule(theirs);
                serverNote = '';
            } else if (quad) {
                await writeRule(quad);
                serverNote = '';
            }
        } catch (err) {
            serverNote = `Could not read or set the device rule: ${err.message}`;
        }
        changed();
    }

    function setQuad(q, write = true) {
        quad = q;
        settings.set('wiglequad.quad', q);
        inside = here ? within(here) : null;
        changed();
        if (!write)
            return Promise.resolve();
        return writeRule(q).then(() => {
            serverNote = '';
            changed();
        });
    }

    // Sounds: a file the user picked, or a tone

    const dbName = 'kismet-wiglequad';
    let dbOpen = null;

    function db() {
        if (!dbOpen) {
            dbOpen = new Promise((resolve, reject) => {
                const req = indexedDB.open(dbName, 1);
                req.onupgradeneeded = () => req.result.createObjectStore('sounds');
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            }).catch((err) => {
                dbOpen = null;
                throw err;
            });
        }
        return dbOpen;
    }

    async function dbDo(mode, fn) {
        const d = await db();
        return new Promise((resolve, reject) => {
            const tx = d.transaction('sounds', mode);
            const req = fn(tx.objectStore('sounds'));
            tx.oncomplete = () => resolve(req?.result);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
    }

    // which -> { name, url, audio }
    const sounds = new Map();

    function useSound(which, blob, name) {
        const old = sounds.get(which);
        if (old)
            URL.revokeObjectURL(old.url);
        if (!blob) {
            sounds.delete(which);
            return;
        }
        const url = URL.createObjectURL(blob);
        sounds.set(which, { name, url, audio: new Audio(url) });
    }

    async function loadSounds() {
        for (const which of ['exit', 'enter']) {
            try {
                const rec = await dbDo('readonly', (st) => st.get(which));
                if (rec?.blob instanceof Blob)
                    useSound(which, rec.blob, String(rec.name ?? ''));
            } catch {
                // No IndexedDB (private window); tones only
            }
        }
        changed();
    }

    async function saveSound(which, file) {
        if (!file)
            return;
        if (file.size > maxSoundBytes)
            throw new Error(`that file is over ${format.size(maxSoundBytes)}; pick a shorter sound`);
        const blob = file.slice(0, file.size, file.type);
        try {
            await dbDo('readwrite', (st) => st.put({ blob, name: file.name }, which));
        } catch {
            // Kept until the page is reloaded
        }
        useSound(which, blob, file.name);
        changed();
    }

    async function clearSound(which) {
        try {
            await dbDo('readwrite', (st) => st.delete(which));
        } catch {
            // Nothing stored
        }
        useSound(which, null);
        changed();
    }

    let audioCtx = null;

    // Falling for leaving, rising for coming back
    function tone(which) {
        audioCtx ??= new AudioContext();
        const notes = which === 'exit' ? [660, 440] : [440, 660, 880];
        let t = audioCtx.currentTime + 0.02;
        for (const f of notes) {
            const o = audioCtx.createOscillator();
            const g = audioCtx.createGain();
            o.frequency.value = f;
            g.gain.setValueAtTime(0.0001, t);
            g.gain.exponentialRampToValueAtTime(0.3, t + 0.02);
            g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
            o.connect(g).connect(audioCtx.destination);
            o.start(t);
            o.stop(t + 0.25);
            t += 0.25;
        }
        return audioCtx.state === 'suspended' ? audioCtx.resume() : Promise.resolve();
    }

    function play(which) {
        const s = sounds.get(which);
        let p;
        try {
            if (s) {
                s.audio.currentTime = 0;
                p = s.audio.play();
            } else {
                p = tone(which);
            }
        } catch (err) {
            p = Promise.reject(err);
        }
        Promise.resolve(p).then(() => {
            if (soundNote) {
                soundNote = '';
                changed();
            }
        }).catch(() => {
            soundNote = 'The browser blocked the sound; click anywhere on the page once to allow it.';
            changed();
        });
    }

    const exitOn = () => settings.get('wiglequad.exitSound', true) !== false;
    const enterOn = () => settings.get('wiglequad.enterSound', true) !== false;
    const repeat = () => {
        const r = Number(settings.get('wiglequad.repeat', 10));
        return repeatChoices.includes(r) ? r : 10;
    };

    function gpsUpdate(e) {
        const p = e['kismet.common.location.geopoint'];
        const fix = e['kismet.common.location.fix'] ?? 0;
        here = fix >= 2 && Array.isArray(p) && (p[0] || p[1]) ? [p[0], p[1]] : null;
        const was = inside;
        inside = quad && here ? within(here) : null;

        const now = Date.now() / 1000;
        if (inside === false) {
            if ((was !== false || now - lastExitSound >= repeat()) && exitOn()) {
                play('exit');
                lastExitSound = now;
            }
        } else if (inside === true && was === false) {
            lastExitSound = 0;
            if (enterOn())
                play('enter');
        }
        if (was !== inside)
            changed();
    }

    eventbus.subscribe('GPS_LOCATION', ['kismet.common.location.fix', 'kismet.common.location.geopoint'], gpsUpdate);
    eventbus.onState((up) => {
        if (up)
            syncServer();
    });

    function stateText() {
        if (!quad)
            return 'No quad set';
        if (!here)
            return 'No GPS fix';
        return inside ? 'In the quad' : 'Outside the quad';
    }

    // The map, the ribbon and the menu

    ui.mapOverlays.add({
        id: 'wiglequad', title: 'WWWD quad', icon: 'target',
        shapes: () => (quad ? [{
            type: 'rect', bounds: [[quad.w, quad.s], [quad.e, quad.n]],
            color: inside === false ? 'var(--error)' : 'var(--ok)', weight: 3, fillOpacity: 0.05,
            label: `WWWD quad: ${stateText().toLowerCase()}`,
        }] : []),
        watch(redraw) {
            listeners.add(redraw);
            return () => listeners.delete(redraw);
        },
    });

    const phyIcons = { 'IEEE802.11': 'wifi', Bluetooth: 'bluetooth', BTLE: 'bluetooth', Cellular: 'tower' };

    ui.mapSources.add({
        id: 'wiglequad', title: 'WWWD quad devices', priority: 40, view: viewId, position: 'average',
        maxAge: 3600, paths: false, range: false,
        icon: (dev) => phyIcons[dev.phy] ?? 'device', layerIcon: 'target',
        color: (dev) => ui.phyColors.get(dev.phy)?.color ?? null,
        detail: (dev) => dev.type || dev.phy,
    });

    ui.ribbonStats.add({
        id: 'wiglequad', title: 'WWWD quad', priority: 900,
        description: 'Whether you are inside your WiGLE WWWD quad; click for the quad',
        create(body) {
            const value = el('span', { class: 'stat-value' });
            body.append(el('span', { class: 'stat-line' }, icons.icon('target'), value));
            const stat = body.parentElement;
            stat.classList.add('clickable');
            stat.addEventListener('click', openQuad);
            const show = () => {
                value.textContent = !quad ? 'No quad' : !here ? 'No GPS' : inside ? 'In quad' : 'Outside';
                stat.title = `WWWD quad: ${stateText().toLowerCase()}`;
                stat.classList.toggle('wiglequad-out', inside === false);
            };
            show();
            listeners.add(show);
            return () => {
                listeners.delete(show);
                stat.removeEventListener('click', openQuad);
                stat.classList.remove('wiglequad-out');
            };
        },
    });

    ui.menuItems.add({ id: 'wiglequad', title: 'WWWD quad', icon: 'target', onClick: () => openQuad() });

    // The window

    let openWindow = null;

    function openQuad() {
        if (openWindow?.node.isConnected) {
            openWindow.raise();
            return openWindow;
        }

        const hideCoords = kismet.censor.current().locations;
        const field = (label, value) => el('input', { type: 'text', inputmode: 'decimal', class: 'wiglequad-coord',
            autocomplete: 'off', value: value === undefined ? '' : String(value), 'aria-label': label });
        const lat0 = field('Latitude from', quad?.s);
        const lat1 = field('Latitude to', quad?.n);
        const lon0 = field('Longitude from', quad?.w);
        const lon1 = field('Longitude to', quad?.e);
        const coords = [lat0, lat1, lon0, lon1];
        if (hideCoords)
            coords.forEach((c) => c.classList.add('wiglequad-censored'));

        const error = el('p', { class: 'wiglequad-error', role: 'alert', hidden: true });
        const busy = (on) => [save, clear].forEach((b) => { b.disabled = on; });

        const save = el('button', { type: 'button', class: 'primary', onclick: async () => {
            const v = coords.map((c) => c.value.trim());
            const n = v.map(Number);
            if (v.some((x) => x === '') || !n.every(Number.isFinite)) {
                showError('Enter all four coordinates as decimal degrees, such as 12.5 or -45.25.');
                return;
            }
            const q = cleanQuad({ s: Math.min(n[0], n[1]), n: Math.max(n[0], n[1]),
                w: Math.min(n[2], n[3]), e: Math.max(n[2], n[3]) });
            if (!q) {
                showError('Latitudes are -90 to 90 and longitudes -180 to 180, and each pair needs two different values.');
                return;
            }
            showError('');
            busy(true);
            try {
                await setQuad(q);
            } catch (err) {
                showError(`The quad is saved in this browser, but the server didn't take the device rule: ${err.message}`);
            } finally {
                busy(false);
            }
        } }, 'Save the quad');

        const clear = el('button', { type: 'button', onclick: async () => {
            coords.forEach((c) => { c.value = ''; });
            showError('');
            busy(true);
            try {
                await setQuad(null);
            } catch (err) {
                showError(`Could not remove the device rule: ${err.message}`);
            } finally {
                busy(false);
            }
        } }, 'Clear');

        function showError(text) {
            error.textContent = text;
            error.hidden = !text;
        }

        const state = el('div', { class: 'wiglequad-state' });
        const viewLine = el('p', { class: 'muted' });
        const note = el('p', { class: 'wiglequad-note', hidden: true });

        function soundRow(which, label) {
            const key = which === 'exit' ? 'wiglequad.exitSound' : 'wiglequad.enterSound';
            const on = el('input', { type: 'checkbox', checked: settings.get(key, true) !== false,
                onchange: () => settings.set(key, on.checked) });
            const name = el('span', { class: 'muted' });
            const picker = el('input', { type: 'file', accept: 'audio/*', hidden: true,
                onchange: async () => {
                    try {
                        await saveSound(which, picker.files?.[0]);
                    } catch (err) {
                        showError(`Could not use that sound: ${err.message}`);
                    }
                    picker.value = '';
                } });
            const reset = el('button', { type: 'button', class: 'link-button', onclick: () => clearSound(which) }, 'Use the tone');
            const show = () => {
                const s = sounds.get(which);
                name.textContent = s ? s.name || 'a sound file' : 'a tone';
                reset.hidden = !s;
            };
            show();
            return {
                show,
                node: el('div', { class: 'wiglequad-sound' },
                    el('label', { class: 'choice-item' }, on, label),
                    el('div', { class: 'wiglequad-sound-file' }, 'Plays ', name,
                        el('button', { type: 'button', class: 'link-button', onclick: () => picker.click() }, 'Choose a file'),
                        reset,
                        el('button', { type: 'button', class: 'icon-button', title: 'Play it', onclick: () => play(which) },
                            icons.icon('play')),
                        picker)),
            };
        }

        const exitRow = soundRow('exit', 'Play a sound when I leave the quad');
        const enterRow = soundRow('enter', 'Play a sound when I come back');
        const repeatSelect = el('select', { 'aria-label': 'How often to repeat the sound while outside',
            onchange: () => settings.set('wiglequad.repeat', Number(repeatSelect.value)) },
            repeatChoices.map((r) => el('option', { value: r, selected: r === repeat() }, `${r} seconds`)));

        let views = null;

        function show() {
            const cls = !quad ? 'none' : !here ? 'nogps' : inside ? 'in' : 'out';
            state.className = `wiglequad-state wiglequad-${cls}`;
            state.replaceChildren(icons.icon('target'), el('span', {}, stateText()));
            const size = views?.get(viewId);
            viewLine.textContent = !quad ? `Once the quad is saved, the server tags the ${kindText.toLowerCase()} ` +
                `seen inside it "${tag}", lists them in the view "${viewTitle}", and the map draws them.` :
                size === undefined ? `${kindText} seen inside the quad are tagged "${tag}".` :
                    `${format.count(size)} seen inside the quad (${kindText.toLowerCase()}), tagged "${tag}".`;
            showDevices.hidden = !quad;
            showMap.hidden = !quad;
            const notes = [serverNote, soundNote].filter(Boolean);
            note.textContent = notes.join('  ');
            note.hidden = !notes.length;
            exitRow.show();
            enterRow.show();
        }

        const showDevices = el('button', { type: 'button', onclick: () => {
            settings.set('devicelist.view', viewId);
            kismet.widgets.panes.showPane('devices');
        } }, 'Show the devices');
        const showMap = el('button', { type: 'button', onclick: () => {
            kismet.widgets.panes.showPane('map');
            kismet.widgets.map.zoomToOverlay('wiglequad');
        } }, 'Show on the map');

        const body = el('div', { class: 'wiglequad-window' },
            state,
            el('p', { class: 'muted' }, 'Your quad for the WiGLE World Wide War Drive, in decimal degrees.  ' +
                'Inspired by @dnsprincess\'s WWWD planner.'),
            hideCoords ? el('p', { class: 'muted' }, 'Censor mode is hiding locations, so the coordinates are blurred.') : null,
            el('div', { class: 'wiglequad-coords' },
                el('span', {}, 'Latitude'), lat0, el('span', {}, 'to'), lat1,
                el('span', {}, 'Longitude'), lon0, el('span', {}, 'to'), lon1),
            error,
            el('div', { class: 'form-buttons' }, clear, save),
            el('h3', {}, 'Devices'),
            viewLine,
            el('div', { class: 'form-buttons wiglequad-links' }, showMap, showDevices),
            el('h3', {}, 'Sounds'),
            exitRow.node,
            el('label', { class: 'field' }, 'While outside, play it again every', repeatSelect),
            enterRow.node,
            note);

        const w = Math.min(560, window.innerWidth - 32);
        const d = dialog({
            title: 'WWWD quad', body, modal: false,
            position: { left: Math.round((window.innerWidth - w) / 2), top: 70, width: w, height: 520 },
            onClose: () => {
                clearInterval(timer);
                listeners.delete(show);
                openWindow = null;
            },
        });

        async function loadViews() {
            if (document.visibilityState === 'hidden')
                return;
            try {
                const list = await api.get('devices/views/all_views.json');
                views = new Map((Array.isArray(list) ? list : [])
                    .map((v) => [v['kismet.devices.view.id'], Number(v['kismet.devices.view.size']) || 0]));
            } catch {
                views = null;
            }
            show();
        }

        listeners.add(show);
        const timer = setInterval(loadViews, 5000);
        loadViews();
        show();
        d.fitContent?.();
        openWindow = d;
        return d;
    }

    loadSounds();
    // The window opens once, to set the quad up, unless the server has one
    syncServer().then(() => {
        if (!quad && !settings.get('wiglequad.introduced', false)) {
            settings.set('wiglequad.introduced', true);
            openQuad();
        }
    });
}
