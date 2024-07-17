
"use strict";

let local_uri_prefix = "";
if (typeof(KISMET_URI_PREFIX) !== 'undefined')
    local_uri_prefix = KISMET_URI_PREFIX;

$('<link>')
    .attr({
        type: 'text/css', 
        rel: 'stylesheet',
        href: local_uri_prefix + 'css/leaflet.css'
    })
    .appendTo('head');

$('<link>')
    .attr({
        type: 'text/css', 
        rel: 'stylesheet',
        href: local_uri_prefix + 'css/Control.Loading.css'
    })
    .appendTo('head');

$('<link>')
    .attr({
        type: 'text/css', 
        rel: 'stylesheet',
        href: local_uri_prefix + 'plugin/wiglequad/css/kismet.wiglequad.css'
    })
    .appendTo('head');

$('<script>')
    .attr({
        src: "js/leaflet.js",
    })
    .appendTo('head');

$('<script>')
    .attr({
        src: "js/Leaflet.MultiOptionsPolyline.min.js",
    })
    .appendTo('head');

$('<script>')
    .attr({
        src: "js/Control.Loading.js",
    })
    .appendTo('head');

$('<script>')
    .attr({
        src: "js/chroma.min.js",
    })
    .appendTo('head');

kismet_ui_sidebar.AddSidebarItem({
    id: 'wwwd_sidebar',
    listTitle: '<i class="fa fa-crosshairs"></i> WWWD',
    clickCallback: () => {
        wwwdWindow();
    }
});

let wwwd_panel = null;
let wwwd_map = null;

let lat0 = kismet.getStorage('kismet.wwwd.lat0', 0.0);
let lat1 = kismet.getStorage('kismet.wwwd.lat1', 0.0);
let lon0 = kismet.getStorage('kismet.wwwd.lon0', 0.0);
let lon1 = kismet.getStorage('kismet.wwwd.lon1', 0.0);

let fname = kismet.getStorage('kismet.wwwd.filename', 'n/a');
let fdata = kismet.getStorage('kismet.wwwd.soundfile', '');

let play_exit = kismet.getStorage('kismet.wwwd.play_exit', true);
let play_enter = kismet.getStorage('kismet.wwwd.play_enter', true);
let play_interval = kismet.getStorage('kismet.wwwd.play_inteval', 10);

let last_sound = 0;
let was_out = -1;

let enter_fname = kismet.getStorage('kismet.wwwd.efilename', 'n/a');
let enter_fdata = kismet.getStorage('kismet.wwwd.esoundfile', '');

let first_time = kismet.getStorage('kismet.wwwd.firsttime', 1);

if (fdata.length != 0) {
    $('#wwwd_audio_main').remove();

    $('html').append(
        $('<audio>', {
            id: 'wwwd_audio_main',
            controls: 'controls',
            style: 'visibility: none;',
            autobuffer: 'autobuffer',
            // autoplay: 'autoplay',
        })
        .append(
            $('<source>', {
                src: fdata,
            })
        )
    );
}

if (enter_fdata.length != 0) {
    $('#wwwd_enter_audio_main').remove();

    $('html').append(
        $('<audio>', {
            id: 'wwwd_enter_audio_main',
            controls: 'controls',
            style: 'visibility: none;',
            autobuffer: 'autobuffer',
            // autoplay: 'autoplay',
        })
        .append(
            $('<source>', {
                src: enter_fdata,
            })
        )
    );
}

let last_gps = null;
let map_border = null;
let map_curloc = null;

kismet_ui_iconbar.AddIconbarItem({
    id: 'wwwd',
    priority: -99999,
    createCallback: div => {
        div.append('<div id="wwwd_toolbar">WWWD</div>');
        div.on('click', () => { wwwdWindow(); });
    },
});

function wwwdPlotMap(map) {
    if (map === null) {
        return;
    }

    if (lat0 != 0 && lat1 != 0 && lon0 != 0 && lon1 != 0) {
        let color = 'green';
        let r = [[lat0, lon0], [lat0, lon1], [lat1, lon1], [lat1, lon0], [lat0, lon0] ];

        if (map_border != null) {
            map.removeLayer(map_border);
        }

        if (last_gps?.['kismet.common.location.fix'] >= 2) {
            let gpslat = last_gps['kismet.common.location.geopoint'][1];
            let gpslon = last_gps['kismet.common.location.geopoint'][0];


            if (Math.abs(gpslat) < Math.abs(lat0) || 
                Math.abs(gpslat) > Math.abs(lat1) || 
                Math.abs(gpslon) < Math.abs(lon0) || 
                Math.abs(gpslon) > Math.abs(lon1)) {
                color = 'red';
            }

            if (map_curloc == null) {
                let posicon = L.divIcon({
                    html: `<div style="width: 24px; height: 24px; transform-origin: center;"><i class="marker-center fa fa-crosshairs" style="color: red; font-size: 24px;"></i></div>`,
                    iconAnchor: [12, 12],
                });

                let marker = L.marker([gpslat, gpslon], {icon: posicon}).addTo(map);

            } else {
                map_curloc.setLatLng(new L.LatLng(gpslat, gpslon));
            }

        }

        map_border = L.polyline(r, {
            color: color,
            weight: 4,
        }).addTo(map);


    }
}

function wwwdGpsRefresh(data) {
    data = kismet.sanitizeObject(data);
    last_gps = data;
    wwwdPlotMap(wwwd_map);

    if (last_gps?.['kismet.common.location.fix'] >= 2) {
        let gpslat = last_gps['kismet.common.location.geopoint'][1];
        let gpslon = last_gps['kismet.common.location.geopoint'][0];

        if (Math.abs(gpslat) < Math.abs(lat0) || 
            Math.abs(gpslat) > Math.abs(lat1) || 
            Math.abs(gpslon) < Math.abs(lon0) || 
            Math.abs(gpslon) > Math.abs(lon1)) {
            was_out = 1;

            let now = Math.floor(Date.now() / 1000)

            if (now - last_sound > play_interval && play_exit && fdata.length > 0) {
                $('#wwwd_audio_main')[0].play();
                last_sound = now;
            }

            $('#wwwd_toolbar').addClass('strike');
        } else {
            if (was_out === 1) {
                $('#wwwd_enter_audio_main')[0].play();
                was_out = 0;
            }

            $('#wwwd_toolbar').removeClass('strike');
        }
    }
}

kismet_ui_base.SubscribeEventbus("GPS_LOCATION", [], function(data) {
    wwwdGpsRefresh(data);
});


function wwwdWindow() {
    let wwwd_content =
        $('<div class="wwwd_content">');

    let optpanel =
        $('<div style="flex: 50; display: flex; flex-direction: column; gap: 5px;">');

    optpanel.html(`
        <div>WWWD Quad</div>
        <div><span style="font-size: smaller;">Monitor and alert on your WWWD quad; inspired by <a href="https://infosec.exchange/@dnsprincess">@dnsprincess</a>!</span></div>
        <div style="display: flex; flex-direction: row; column-gap: 5px;">
            <div><b>Lat:</b></div>
            <input id="wwwd_lat0" value="${lat0}" style="width: 10em;"></input>
            <div><b>to:</b></div>
            <input id="wwwd_lat1" value="${lat1}" style="width: 10em;"></input>
        </div>
        <div style="display: flex; flex-direction: row; column-gap: 10px;">
            <div><b>Lon:</b></div>
            <input id="wwwd_lon0" value="${lon0}" "style="width: 10em;"></input>
            <div><b>to:</b></div>
            <input id="wwwd_lon1" value="${lon1}" style="width: 10em;"></input>
        </div>
            <div id="wwwd_error"></div>
        <div>
            <button id="wwwd_update">Update Coordinates</button>
        </div>
        <hr>
        <div>Play alert when out of quad <input type="checkbox" id="play_exit"></input></div>
        <div id="wwwd_audio_holder" style="display: flex; flex-direction: column; max-width: 250px;">
            <input type="file" id="audioelem" accept="audio/*" style="display: none;"></input>
            <div>Exit alert: <span id="wwwd_fname">${fname}</span> | <button id="wwwd_file">Select audio file</button></div>
        </div>
        <div></div>
        <div>Play alert when returning to quad <input type="checkbox" id="play_enter"></input></div>
        <div id="wwwd_enter_audio_holder" style="display: flex; flex-direction: column; max-width: 250px;">
            <input type="file" id="enter_audioelem" accept="audio/*" style="display: none;"></input>
            <div>Enter alert: <span id="wwwd_enter_fname">${enter_fname}</span> | <button id="wwwd_enter_file">Select audio file</button></div>
        </div>
    `);

    if (fdata.length != 0) {
        $('#wwwd_audio', optpanel).remove();

        $('#wwwd_audio_holder', optpanel).append(
            $('<audio>', {
                id: 'wwwd_audio',
                controls: 'controls',
                autobuffer: 'autobuffer',
                // autoplay: 'autoplay',
            })
            .append(
                $('<source>', {
                    src: fdata,
                })
            )
        );
    }

    if (enter_fdata.length != 0) {
        $('#wwwd_enter_audio', optpanel).remove();

        $('#wwwd_enter_audio_holder', optpanel).append(
            $('<audio>', {
                id: 'wwwd_enter_audio',
                controls: 'controls',
                autobuffer: 'autobuffer',
                // autoplay: 'autoplay',
            })
            .append(
                $('<source>', {
                    src: enter_fdata,
                })
            )
        );
    }

    $('#play_exit', optpanel).prop('checked', play_exit);
    $('#play_enter', optpanel).prop('checked', play_enter);

    $('#play_exit', optpanel).on('change', () => {
        play_exit = $('#play_exit', optpanel).prop('checked');
        kismet.putStorage('kismet.wwwd.play_exit', play_exit);
    })

    $('#play_enter', optpanel).on('change', () => {
        play_enter = $('#play_enter', optpanel).prop('checked');
        kismet.putStorage('kismet.wwwd.play_enter', play_enter);
    })

    $('#audioelem', optpanel).on('change', () => {
        let file = $('#audioelem', optpanel)[0].files[0];

        file.arrayBuffer().then((buffer) => {
            fdata = 'data:' + file.ttpe + ';base64,' + btoa([].reduce.call(new Uint8Array(buffer), (p, c) => { return p+String.fromCharCode(c); }, ''));
            fname = file.name;

            kismet.putStorage('kismet.wwwd.soundfile', fdata);
            kismet.putStorage('kismet.wwwd.filename', file.name);

            $('#wwwd_fname', optpanel).html(file.name);

            $('#wwwd_audio', optpanel).remove();

            $('#wwwd_audio_holder', optpanel).append(
                $('<audio>', {
                    id: 'wwwd_audio',
                    controls: 'controls',
                    autobuffer: 'autobuffer',
                    autoplay: 'autoplay',
                })
                .append(
                    $('<source>', {
                        src: fdata,
                    })
                )
            );

            $('#wwwd_audio_main').remove();
            $('html').append(
                $('<audio>', {
                    id: 'wwwd_audio_main',
                    controls: 'controls',
                    style: 'visibility: none;',
                    autobuffer: 'autobuffer',
                    // autoplay: 'autoplay',
                })
                .append(
                    $('<source>', {
                        src: fdata,
                    })
                )
            );

        });
    });

    $('#wwwd_file', optpanel).on('click', () => {
        $('#audioelem', optpanel).click();
    });


    $('#enter_audioelem', optpanel).on('change', () => {
        let file = $('#enter_audioelem', optpanel)[0].files[0];

        file.arrayBuffer().then((buffer) => {
            enter_fdata = 'data:' + file.ttpe + ';base64,' + btoa([].reduce.call(new Uint8Array(buffer), (p, c) => { return p+String.fromCharCode(c); }, ''));
            enter_fname = file.name;

            kismet.putStorage('kismet.wwwd.esoundfile', enter_fdata);
            kismet.putStorage('kismet.wwwd.efilename', file.name);

            $('#wwwd_enter_fname', optpanel).html(file.name);
            $('#wwwd_enter_audio', optpanel).remove();

            $('#wwwd_enter_audio_holder', optpanel).append(
                $('<audio>', {
                    id: 'wwwd_enter_audio',
                    controls: 'controls',
                    autobuffer: 'autobuffer',
                    autoplay: 'autoplay',
                })
                .append(
                    $('<source>', {
                        src: enter_fdata,
                    })
                )
            );

            $('#wwwd_enter_audio_main').remove();
            $('html').append(
                $('<audio>', {
                    id: 'wwwd_enter_audio_main',
                    controls: 'controls',
                    style: 'visibility: none;',
                    autobuffer: 'autobuffer',
                    // autoplay: 'autoplay',
                })
                .append(
                    $('<source>', {
                        src: enter_fdata,
                    })
                )
            );
        });
    });

    $('#wwwd_enter_file', optpanel).on('click', () => {
        $('#enter_audioelem', optpanel).click();
    });

/*
    setInterval(() => {
        $('#wwwd_audio', optpanel)[0].play();
    }, 5000);
    */

    $('button', optpanel).on('click', () => {
        let llat0 = $('#wwwd_lat0', optpanel).val();
        let llat1 = $('#wwwd_lat1', optpanel).val();
        let llon0 = $('#wwwd_lon0', optpanel).val();
        let llon1 = $('#wwwd_lon1', optpanel).val();

        if (isNaN(llat0) || isNaN(llat1) || isNaN(llon0) || isNaN(llon1)) {
            $('#wwwd_error', optpanel).html("[ Error:  Invalid coordinates ]");
            return;
        } else {
            $('#wwwd_error').html("");
        }

        kismet.putStorage('kismet.wwwd.lat0', llat0);
        kismet.putStorage('kismet.wwwd.lat1', llat1);
        kismet.putStorage('kismet.wwwd.lon0', llon0);
        kismet.putStorage('kismet.wwwd.lon1', llon1);

        lat0 = llat0;
        lat1 = llat1;
        lon0 = llon0;
        lon1 = llon1;

        wwwdPlotMap(wwwd_map);

        wwwd_map.fitBounds([[llat0, llon0], [llat1, llon1]]);
    });

    let mappanel = 
        $('<div style="flex: 50; display: flex; flex-direction: column; padding-right: 50px; padding-bottom: 50px;">');

    mappanel.html(`
        <div id="wwwd_map"></div>
        `)

    wwwd_content.append(optpanel);
    wwwd_content.append(mappanel);

    let w = $(window).width() * 0.75;
    let h = $(window).height() * 0.5;
    let offty = 20;

    if ($(window).width() < 450 || $(window).height() < 450) {
        w = $(window).width() - 5;
        h = $(window).height() - 5;
        offty = 0;
    }

    $(document).on('jspanelfronted', function (event, id) {
        if (id === 'wwwd-panel') {
            // Use the map presence as a key for first-time initialization
            if (wwwd_map === null) {
                wwwd_map = L.map('wwwd_map', {
                    loadingControl: true
                });
                wwwd_map.setView(new L.LatLng(0, 0), 2);

                if (lat0 != 0 && lat1 != 0 && lon0 != 0 && lon1 != 0) {
                    wwwd_map.fitBounds([[lat0, lon0], [lat1, lon1]]);
                    wwwdPlotMap(wwwd_map);
                }

                L.tileLayer('http://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                    maxZoom: 19,
                    attribution: '&copy; <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a>',
                    className: 'map-tiles',
                }).addTo(wwwd_map);
            }
        }
    });

    wwwd_panel = $.jsPanel({
        id: 'wwwd-panel',
        headerTitle: '<i class="fa fa-crosshairs"></i> Wigle WWWD',
        headerControls: {
            controls: 'closeonly',
            iconfont: 'jsglyph',
        },
        content: wwwd_content,
        onclosed: () => {
            wwwd_panel = null;
            wwwd_map = null;
            map_border = null;
            map_curloc = null;
        },
    }).resize({
        width: w,
        height: h,
    }).reposition({
        my: 'center-top',
        at: 'center-top',
        of: 'window',
        offsetY: offty,
    })
    .front();

}

if (first_time) {
    kismet.putStorage('kismet.wwwd.firsttime', 0);
    wwwdWindow();
}

console.log("Loaded wiglequad plugin");
