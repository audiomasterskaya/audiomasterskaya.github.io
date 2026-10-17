(function(){
'use strict';

var ctx = new (window.AudioContext || window.webkitAudioContext)();
var audioWarmedUp = false;

function warmupAudio(){
    if(audioWarmedUp) return;
    audioWarmedUp = true;
    try{
        if(ctx.state === 'suspended'){
            ctx.resume().then(function(){
                var warmBuf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 0.1), ctx.sampleRate);
                var warmSrc = ctx.createBufferSource();
                warmSrc.buffer = warmBuf;
                var warmGain = ctx.createGain();
                warmGain.gain.value = 0.001;
                warmSrc.connect(warmGain);
                warmGain.connect(ctx.destination);
                warmSrc.start();
            }).catch(function(e){ console.warn('warmup resume failed', e); });
        } else {
            var warmBuf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 0.1), ctx.sampleRate);
            var warmSrc = ctx.createBufferSource();
            warmSrc.buffer = warmBuf;
            var warmGain = ctx.createGain();
            warmGain.gain.value = 0.001;
            warmSrc.connect(warmGain);
            warmGain.connect(ctx.destination);
            warmSrc.start();
        }
    }catch(e){ console.warn('warmup failed', e); }
}

document.addEventListener('click', function _warmupOnFirstClick(){
    warmupAudio();
    document.removeEventListener('click', _warmupOnFirstClick);
}, true);

/* ============================================================
   МОДЕЛЬ ДАННЫХ
   ============================================================ */
var sources = [];
var sourceIdSeq = 0;
var activeSourceId = null;

var fragments = [];
var fragIdSeq = 0;
var selectedFragIds = [];
var selectionAnchor = null;

function isFragSelected(id){
    for(var i=0;i<selectedFragIds.length;i++) if(selectedFragIds[i] === id) return true;
    return false;
}
function setSelectedFragIds(ids){
    selectedFragIds = ids.slice();
}
function clearSelection(){
    selectedFragIds = [];
    selectionAnchor = null;
}
function toggleFragSelection(id){
    for(var i=0;i<selectedFragIds.length;i++){
        if(selectedFragIds[i] === id){ selectedFragIds.splice(i,1); return; }
    }
    selectedFragIds.push(id);
}
function getSelectedFragIndexes(){
    var res = [];
    for(var i=0;i<fragments.length;i++){
        if(isFragSelected(fragments[i].id)) res.push(i);
    }
    return res;
}
function getFirstSelectedFragId(){
    if(selectedFragIds.length === 0) return null;
    for(var i=0;i<fragments.length;i++){
        if(isFragSelected(fragments[i].id)) return fragments[i].id;
    }
    return null;
}
function getLastSelectedFragId(){
    if(selectedFragIds.length === 0) return null;
    for(var i=fragments.length-1;i>=0;i--){
        if(isFragSelected(fragments[i].id)) return fragments[i].id;
    }
    return null;
}
function selectAllFragments(){
    if(fragments.length === 0) return;
    var ids = [];
    for(var i=0;i<fragments.length;i++) ids.push(fragments[i].id);
    setSelectedFragIds(ids);
    selectionAnchor = ids[0];
    refreshSelectionUI();
    setStatus('Выделено фрагментов: ' + ids.length);
}

var T = {source:null,gain:null,playing:false,paused:false,stopped:false,startT:0,startO:0,pausedAt:0,raf:null,token:0,seeking:false,markIn:0,markOut:0,dragMode:null,dragStartX:0,dragStartVal:0};
var tl = {playing:false, paused:false, startT:0, startPos:0, pausePos:0, sources:[], raf:null, token:0, seeking:false, loop:false, dragMode:null, dragStartX:0, dragStartVal:0, pausedAt:0};

var activeContext = 'player';
var EDGE_FADE = { enabled: true, inMs: 50, outMs: 50 };
var FRAG_VOL_MIN = 0.0;
var FRAG_VOL_MAX = 2.0;
var FRAG_VOL_DEFAULT = 1.0;
var XFADE = { enabled: false, defaultMs: 270, maxMs: 3000 };

var cache=null, cacheBuf=null;
var MARK_RADIUS = 7;
var MARK_HIT_PAD = 4;

function $(id){return document.getElementById(id);}
function setStatus(t,err){
    var e = $('statusText');
    if(!e) return;
    e.textContent = t;
    e.title = t;
    e.className = 'status-inline' + (err ? ' err' : '');
}

/* ===== Оверлей загрузки ===== */
function showLoadOverlay(){
    var ov = $('loadOverlay');
    if(ov) ov.classList.add('active');
    var pb = $('blockPlayer');
    if(pb) pb.classList.add('player-busy');
}
function hideLoadOverlay(){
    var ov = $('loadOverlay');
    if(ov) ov.classList.remove('active');
    var pb = $('blockPlayer');
    if(pb) pb.classList.remove('player-busy');
    var bar = $('loadBar');
    if(bar) bar.classList.remove('active','indeterminate');
    var fill = $('loadBarFill');
    if(fill) fill.style.width = '0%';
    var pct = $('loadPercent');
    if(pct) pct.textContent = '';
    var txt = $('loadText');
    if(txt) txt.textContent = 'Читаю файл…';
}
function setLoadText(txt){
    var el = $('loadText');
    if(el) el.textContent = txt;
}
function setLoadProgress(percent){
    var bar = $('loadBar');
    var fill = $('loadBarFill');
    var pct = $('loadPercent');
    if(bar){ bar.classList.add('active'); bar.classList.remove('indeterminate'); }
    if(fill) fill.style.width = Math.max(0, Math.min(100, percent)) + '%';
    if(pct) pct.textContent = Math.round(percent) + '%';
}
function setLoadIndeterminate(){
    var bar = $('loadBar');
    var pct = $('loadPercent');
    if(bar){ bar.classList.add('active'); bar.classList.add('indeterminate'); }
    if(pct) pct.textContent = '';
}

function fmtTime(sec){
    if(isNaN(sec) || sec < 0) sec = 0;
    var total = Math.floor(sec);
    var m = Math.floor(total / 60);
    var s = total % 60;
    var ms = Math.floor((sec - total) * 1000);
    if(ms > 999) ms = 999;
    function pad(n, w){ n = String(n); while(n.length < w) n = '0' + n; return n; }
    return pad(m, 2) + ':' + pad(s, 2) + '.' + pad(ms, 3);
}

/* ===== Источники ===== */
function findSourceById(id){
    for(var i=0;i<sources.length;i++) if(sources[i].id === id) return sources[i];
    return null;
}
function getActiveSource(){
    return activeSourceId === null ? null : findSourceById(activeSourceId);
}
function getBufferForFrag(f){
    if(!f) return null;
    var s = findSourceById(f.sourceId);
    return s ? s.buffer : null;
}

function makeSourceFromBuffer(name, buf){
    return {
        id: ++sourceIdSeq,
        name: name,
        buffer: buf,
        sampleRate: buf.sampleRate,
        numberOfChannels: buf.numberOfChannels,
        length: buf.length,
        duration: buf.duration
    };
}

/* ===== Кнопки ИСХОДНИКА ===== */
function setPlayerButtonsEnabled(enabled){
    var ids = ['btnPlay1','btnGotoStart','btnMarkIn','btnMarkOut','btnGotoEnd','btnAddFrag'];
    for(var i=0;i<ids.length;i++){
        var el = $(ids[i]);
        if(el) el.disabled = !enabled;
    }
}

function renderActivePanel(){
    var s = getActiveSource();
    var empty = $('activeEmpty');
    var area = $('area1');

    if(!s || !s.buffer){
        empty.style.display = 'flex';
        area.style.display = 'none';
        setPlayerButtonsEnabled(false);
        var bStop = $('btnStop1'); if(bStop) bStop.disabled = true;
        $('lblStart1').textContent = '— : — . —';
        $('lblEnd1').textContent = '— : — . —';
        $('total1').textContent = '— : — . —';
        $('selDur1').textContent = '— : — . —';
        $('tcCur1').textContent = '— : — . —';
        return;
    }

    empty.style.display = 'none';
    area.style.display = 'block';

    var dur = s.buffer.duration;
    $('total1').textContent = fmtTime(dur);
    $('waveName1').textContent = s.name;
    $('waveName1').title = s.name;

    T.markIn = 0;
    T.markOut = dur;
    $('lblStart1').textContent = fmtTime(0);
    $('lblEnd1').textContent = fmtTime(dur);

    setPlayerButtonsEnabled(true);
    invalidateWaveCache();
    redraw();
    updateBtns();
    updateTimecode();
}

/* ===== Загрузка файла ===== */
function addSourceFromFile(file){
    if(!file) return;
    warmupAudio();
    if(!file.type.startsWith('audio/') && !/\.(mp3|wav|ogg|m4a|aac|flac|opus|webm)$/i.test(file.name)){
        setStatus('Файл «'+file.name+'» не похож на аудио', true);
        return;
    }

    showLoadOverlay();
    setLoadText('Читаю файл: ' + file.name);
    setLoadProgress(0);
    setStatus('Читаю файл: ' + file.name + '…');

    var reader = new FileReader();

    reader.onprogress = function(e){
        if(e.lengthComputable){
            var pct = (e.loaded / e.total) * 100;
            setLoadProgress(pct);
        }
    };

    reader.onerror = function(){
        hideLoadOverlay();
        setStatus('Ошибка чтения файла «' + file.name + '»', true);
    };

    reader.onload = function(){
        setLoadText('Декодирую: ' + file.name);
        setLoadIndeterminate();
        setStatus('Декодирую: ' + file.name + '…');

        var ab = reader.result;

        var decodePromise;
        try{
            decodePromise = ctx.decodeAudioData(ab.slice(0));
        }catch(e){
            decodePromise = new Promise(function(resolve, reject){
                ctx.decodeAudioData(ab.slice(0), resolve, reject);
            });
        }

        decodePromise
            .then(function(buf){
                setLoadText('Рисую волну…');
                setLoadIndeterminate();
                setStatus('Рисую волну…');

                return new Promise(function(resolve){
                    requestAnimationFrame(function(){
                        requestAnimationFrame(function(){ resolve(buf); });
                    });
                });
            })
            .then(function(buf){
                var slot = null;
                for(var i=0;i<sources.length;i++){
                    if(sources[i].name === file.name && sources[i].length === buf.length){
                        slot = sources[i]; break;
                    }
                }
                if(slot){
                    slot.buffer = buf;
                    slot.sampleRate = buf.sampleRate;
                    slot.numberOfChannels = buf.numberOfChannels;
                    slot.duration = buf.duration;
                    setStatus('Открыт «' + file.name + '» (файл уже был в сессии). Файл готов. Нажмите P или «⬇ В Мастер».');
                } else {
                    var s = makeSourceFromBuffer(file.name, buf);
                    sources.push(s);
                    slot = s;
                    setStatus('Открыт «' + file.name + '». Файл готов. Нажмите P или «⬇ В Мастер».');
                }

                stop(false);
                activeSourceId = slot.id;

                renderActivePanel();
                resetMarks();
                updateBtns();

                hideLoadOverlay();
                setStatus('Файл готов. Нажмите P или «⬇ В Мастер» — фрагмент уйдёт в Мастер.');
            })
            .catch(function(err){
                console.error(err);
                hideLoadOverlay();
                setStatus('Ошибка декодирования файла «' + file.name + '»', true);
            });
    };

    reader.readAsArrayBuffer(file);
}

function initFileZone(){
    var zone = $('zone1');
    var dz   = $('activeEmpty');
    var inp  = $('file1');

    function handleFiles(files){
        if(!files || !files.length) return;
        if(files.length > 1){
            setStatus('За раз загружается только один файл. Берём первый.', true);
        }
        addSourceFromFile(files[0]);
    }

    zone.addEventListener('dragover', function(e){ e.preventDefault(); zone.classList.add('dragover'); });
    zone.addEventListener('dragleave', function(){ zone.classList.remove('dragover'); });
    zone.addEventListener('drop', function(e){
        e.preventDefault();
        zone.classList.remove('dragover');
        handleFiles(e.dataTransfer.files);
    });

    if(dz){
        var dzTitle = dz.querySelector('.dropzone-title');
        var dzHint  = dz.querySelector('.dropzone-hint');
        var titleOrig = dzTitle ? dzTitle.textContent : '';
        var hintOrig  = dzHint  ? dzHint.textContent  : '';

        function setDzText(title, hint){
            if(dzTitle) dzTitle.textContent = title;
            if(dzHint)  dzHint.textContent  = hint;
        }
        function resetDzText(){
            if(dzTitle) dzTitle.textContent = titleOrig;
            if(dzHint)  dzHint.textContent  = hintOrig;
        }

        dz.addEventListener('dragover', function(e){
            e.preventDefault();
            dz.classList.add('dragover');
            setDzText('Бросай сюда, не бойся!', '🎵 Отпусти мышку — и файл в работе');
        });
        dz.addEventListener('dragleave', function(){
            dz.classList.remove('dragover');
            resetDzText();
        });
        dz.addEventListener('drop', function(e){
            e.preventDefault();
            dz.classList.remove('dragover');
            resetDzText();
            handleFiles(e.dataTransfer.files);
        });
        dz.addEventListener('click', function(){
            inp.click();
        });
    }

    inp.addEventListener('change', function(e){
        handleFiles(e.target.files);
        inp.value = '';
    });

    var cvs = $('canvas1');
    if(cvs){
        cvs.addEventListener('contextmenu', function(e){
            e.preventDefault();
            inp.click();
        });
    }
}

function removeActiveSource(){
    var s = getActiveSource();
    if(!s || !s.buffer){
        setStatus('В ИСХОДНИКЕ нет загруженного файла', true);
        return;
    }

    var ok = window.confirm('Удалить файл «' + s.name + '» из ИСХОДНИКА?\n\nФрагменты в МАСТЕРЕ останутся и продолжат работать.');
    if(!ok){
        setStatus('Удаление отменено');
        return;
    }

    var removedName = s.name;

    stop(false);

    activeSourceId = null;

    T.playing = false;
    T.paused = false;
    T.stopped = false;
    T.pausedAt = 0;
    T.markIn = 0;
    T.markOut = 0;
    cache = null;
    cacheBuf = null;

    renderActivePanel();
    redraw();

    setStatus('Файл «' + removedName + '» удалён из ИСХОДНИКА. Фрагменты в МАСТЕРЕ не затронуты.');
}

/* ===== Метки ===== */
function resetMarks(){
    var s = getActiveSource();
    if(!s || !s.buffer) return;
    var dur = s.buffer.duration;
    T.markIn = 0;
    T.markOut = dur;
    $('lblStart1').textContent = fmtTime(0);
    $('lblEnd1').textContent = fmtTime(dur);
    T.pausedAt = 0;
    T.paused = false;
    T.playing = false;
    T.stopped = false;
    redraw();
    updateTimecode();
}

function markPoint(target){
    var s = getActiveSource();
    if(!s || !s.buffer){ setStatus('Нет активного источника', true); return; }
    setActiveContext('player');
    var cur = getCurrentPos();
    cur = Math.max(0, Math.min(s.buffer.duration, cur));
    var dur = s.buffer.duration;

    if(target === 'start'){
        T.markIn = cur;
        if(T.markIn >= T.markOut){
            T.markOut = dur;
            $('lblEnd1').textContent = fmtTime(T.markOut);
            setStatus('Вход поставлен на ' + fmtTime(T.markIn) + '; выход перенесён в конец файла');
        }
        $('lblStart1').textContent = fmtTime(T.markIn);
    } else {
        T.markOut = cur;
        if(T.markOut <= T.markIn){
            T.markIn = 0;
            $('lblStart1').textContent = fmtTime(0);
            setStatus('Выход поставлен на ' + fmtTime(T.markOut) + '; вход перенесён в начало файла');
        }
        $('lblEnd1').textContent = fmtTime(T.markOut);
    }
    redraw(); updateTimecode();
}

function initMarkButtons(){
    var btns = document.querySelectorAll('.btn-mark');
    for(var i=0;i<btns.length;i++){
        (function(btn){
            btn.addEventListener('click', function(){
                markPoint(btn.getAttribute('data-target'));
            });
        })(btns[i]);
    }
}

/* ===== Активный контекст ===== */
function setActiveContext(name){
    if(activeContext === name){ updateActiveHighlight(); return; }
    activeContext = name;
    updateActiveHighlight();
}
function updateActiveHighlight(){
    var pb = $('blockPlayer'), tb = $('blockTimeline');
    if(activeContext === 'player'){ pb.classList.add('active-player'); tb.classList.remove('active-player'); }
    else { tb.classList.add('active-player'); pb.classList.remove('active-player'); }
}

/* ===== Волна ===== */
function getMix(){
    var s = getActiveSource();
    if(!s || !s.buffer) return null;
    var buf = s.buffer;
    if(cacheBuf===buf && cache) return cache;
    var ch=buf.numberOfChannels, n=buf.length, d=new Float32Array(n);
    for(var c=0;c<ch;c++){ var sd=buf.getChannelData(c); for(var i=0;i<n;i++) d[i]+=sd[i]/ch; }
    cache=d; cacheBuf=buf; return d;
}

var waveBaseCanvas = null;
var waveBaseKey = '';

function waveBaseSignature(s, w, h, dpr){
    if(!s || !s.buffer) return '';
    return [
        s.id, s.buffer.length,
        w, h, dpr,
        cacheBuf === s.buffer ? 1 : 0
    ].join('|');
}

function buildWaveBaseCanvas(s, w, h, dpr){
    var off = document.createElement('canvas');
    off.width  = Math.floor(w * dpr);
    off.height = Math.floor(h * dpr);
    var g = off.getContext('2d');
    g.setTransform(dpr,0,0,dpr,0,0);

    var buf = s.buffer;
    var mid = h/2;
    g.fillStyle='#0b0b0b'; g.fillRect(0,0,w,h);

    var data = getMix(), n = data.length, step = Math.max(1, Math.ceil(n/w));
    g.strokeStyle='#00adb5'; g.lineWidth=1; g.beginPath();
    for(var i=0;i<w;i++){
        var mn=1, mx=-1, s0=Math.floor(i*step), e0=Math.min(s0+step,n);
        for(var j=s0;j<e0;j++){ var v=data[j]; if(v<mn)mn=v; if(v>mx)mx=v; }
        g.moveTo(i,(1+mn)*mid); g.lineTo(i,(1+mx)*mid);
    }
    g.stroke();

    return off;
}

function drawWaveOverlay(g, s, w, h){
    var buf = s.buffer;
    var dur = buf.duration;
    var sV = T.markIn || 0;
    var eV = (T.markOut && T.markOut > 0) ? T.markOut : dur;
    var x1 = (sV/dur)*w, x2 = (eV/dur)*w;

    g.fillStyle='rgba(0,173,181,0.18)';
    g.fillRect(x1, 0, x2 - x1, h);

    g.strokeStyle='#28a745'; g.lineWidth=2; g.beginPath();
    g.moveTo(x1,0); g.lineTo(x1,h); g.stroke();
    drawHandle(g, x1, MARK_RADIUS + 2, '#28a745');
    drawHandle(g, x1, h - MARK_RADIUS - 2, '#28a745');

    g.strokeStyle='#ffb300'; g.lineWidth=2; g.beginPath();
    g.moveTo(x2,0); g.lineTo(x2,h); g.stroke();
    drawHandle(g, x2, MARK_RADIUS + 2, '#ffb300');
    drawHandle(g, x2, h - MARK_RADIUS - 2, '#ffb300');

    var cur = getCurrentPos();
    var px  = (cur / dur) * w;
    g.strokeStyle='#ff5252'; g.lineWidth=2; g.beginPath();
    g.moveTo(px,0); g.lineTo(px,h); g.stroke();
    g.fillStyle='#ff5252'; g.beginPath();
    g.moveTo(px-6, 0); g.lineTo(px+6, 0); g.lineTo(px, 10); g.closePath(); g.fill();
    drawHandle(g, px, h - MARK_RADIUS - 2, '#ff5252');
}

function redraw(){
    var cvs = $('canvas1'), s = getActiveSource();
    if(!s || !s.buffer) return;

    var w = cvs.clientWidth  || 700;
    var h = cvs.clientHeight || 140;
    var dpr = window.devicePixelRatio || 1;
    if(cvs.width !== Math.floor(w*dpr) || cvs.height !== Math.floor(h*dpr)){
        cvs.width  = Math.floor(w*dpr);
        cvs.height = Math.floor(h*dpr);
    }
    var g = cvs.getContext('2d');
    g.setTransform(dpr,0,0,dpr,0,0);

    var sig = waveBaseSignature(s, w, h, dpr);
    if(sig !== waveBaseKey || !waveBaseCanvas){
        waveBaseCanvas = buildWaveBaseCanvas(s, w, h, dpr);
        waveBaseKey = sig;
    }

    g.save();
    g.setTransform(1,0,0,1,0,0);
    g.drawImage(waveBaseCanvas, 0, 0);
    g.restore();

    drawWaveOverlay(g, s, w, h);
}

function redrawPlayheadOnly(){
    var cvs = $('canvas1'), s = getActiveSource();
    if(!s || !s.buffer) return;
    if(!waveBaseCanvas){ redraw(); return; }

    var w = cvs.clientWidth  || 700;
    var h = cvs.clientHeight || 140;
    var g = cvs.getContext('2d');

    g.save();
    g.setTransform(1,0,0,1,0,0);
    g.drawImage(waveBaseCanvas, 0, 0);
    g.restore();

    drawWaveOverlay(g, s, w, h);
}

function drawHandle(g, x, y, color){
    g.beginPath();
    g.arc(x, y, MARK_RADIUS, 0, Math.PI * 2);
    g.fillStyle = color;
    g.fill();
    g.lineWidth = 2;
    g.strokeStyle = '#111';
    g.stroke();
}

function updateTimecode(){
    var s = getActiveSource();
    if(!s || !s.buffer) return;
    var sV = T.markIn || 0;
    var eV = (T.markOut && T.markOut > 0) ? T.markOut : s.buffer.duration;
    $('selDur1').textContent  = fmtTime(eV - sV);
    var cur = null;
    if(T.playing){ cur = T.startO + (ctx.currentTime - T.startT); if(cur > s.buffer.duration) cur = s.buffer.duration; }
    else if(T.paused){ cur = T.pausedAt; }
    $('tcCur1').textContent = (cur !== null) ? fmtTime(cur) : '— : — . —';
}

function getCurrentPos(){
    var s = getActiveSource();
    if(!s || !s.buffer) return 0;
    if(T.playing){ var cur = T.startO + (ctx.currentTime - T.startT); if(cur > s.buffer.duration) cur = s.buffer.duration; return cur; }
    else if(T.paused) return T.pausedAt;
    else if(T.stopped) return 0;
    else return T.markIn || 0;
}

function getWaveGeom(){
    var cvs = $('canvas1');
    var s = getActiveSource();
    if(!cvs || !s || !s.buffer) return null;
    var w = cvs.clientWidth;
    var h = cvs.clientHeight;
    var dur = s.buffer.duration;
    if(w <= 0 || h <= 0 || dur <= 0) return null;
    return { w:w, h:h, dur:dur, topY: MARK_RADIUS + 2, botY: h - MARK_RADIUS - 2 };
}

function timeToX(sec, geom){
    if(!geom) return 0;
    return (sec / geom.dur) * geom.w;
}

function hitTestWave(x, y){
    var geom = getWaveGeom();
    if(!geom) return null;
    var hitR = MARK_RADIUS + MARK_HIT_PAD;

    var xIn  = timeToX(T.markIn, geom);
    var xOut = timeToX(T.markOut, geom);
    var cur  = getCurrentPos();
    var xPl  = timeToX(cur, geom);

    function near(x1, y1, x2, y2){
        var dx = x1 - x2, dy = y1 - y2;
        return (dx*dx + dy*dy) <= (hitR * hitR);
    }

    var PLAY_HIT_W = 7;
    if(Math.abs(x - xPl) <= PLAY_HIT_W) return 'play';

    if(near(x, y, xIn, geom.topY)) return 'in';
    if(near(x, y, xIn, geom.botY)) return 'in';

    if(near(x, y, xOut, geom.topY)) return 'out';
    if(near(x, y, xOut, geom.botY)) return 'out';

    return null;
}

/* ===== Плеер ИСХОДНИКА ===== */
function updateBtns(){
    var pB = $('btnPlay1'), stB = $('btnStop1');
    var s = getActiveSource();
    var hasBuf = s && s.buffer;
    if(T.playing){
        pB.textContent = '❚❚ Пауза'; pB.disabled = false; stB.disabled = false;
    } else if(T.paused){
        pB.textContent = '▶ Продолжить'; pB.disabled = false; stB.disabled = false;
    } else {
        pB.textContent = '▶ Воспроизвести'; pB.disabled = !hasBuf; stB.disabled = true;
    }
}

function ensureCtx(cb){
    if(ctx.state==='suspended'){
        ctx.resume().then(function(){
            if(!audioWarmedUp){
                audioWarmedUp = true;
                var warmBuf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 0.1), ctx.sampleRate);
                var warmSrc = ctx.createBufferSource();
                warmSrc.buffer = warmBuf;
                var warmGain = ctx.createGain();
                warmGain.gain.value = 0.001;
                warmSrc.connect(warmGain);
                warmGain.connect(ctx.destination);
                warmSrc.start();
            }
            cb();
        }).catch(function(e){console.warn(e);cb();});
    } else cb();
}

function play(start,end){
    var s = getActiveSource();
    if(!s || !s.buffer) return;
    if(tl.playing) tlPause();
    if(T.source){ try{ T.source.onended=null; T.source.stop(); }catch(e){} try{ T.source.disconnect(); }catch(e){} }
    stopLoop();
    T.token = (T.token||0)+1;
    var myToken = T.token;
    ensureCtx(function(){
        if(myToken !== T.token) return;
        var buf = s.buffer;
        var src=ctx.createBufferSource(); src.buffer=buf;
        var g=ctx.createGain(); g.gain.value=1.0;
        src.connect(g); g.connect(ctx.destination);
        var ss = Math.max(0, Math.min(start, buf.duration));
        var ee = Math.max(ss + 0.01, Math.min(end, buf.duration));
        src.start(0, ss, ee - ss);
        T.source=src; T.gain=g; T.playing=true; T.paused=false; T.stopped=false;
        T.startT=ctx.currentTime; T.startO=ss; T.pausedAt=ss;
        setActiveContext('player');
        updateBtns(); loop();
        src.onended=function(){
            if(myToken !== T.token) return;
            if(T.playing){ T.playing=false; T.paused=false; updateBtns(); stopLoop(); }
        };
    });
}
function pause(){
    if(!T.playing) return;
    var s = getActiveSource();
    if(!s || !s.buffer) return;
    var cur=T.startO+(ctx.currentTime-T.startT);
    T.token=(T.token||0)+1;
    try{ T.source.onended=null; }catch(e){}
    try{ T.source.stop(); }catch(e){}
    try{ T.source.disconnect(); }catch(e){}
    try{ T.gain.disconnect(); }catch(e){}
    T.source=null; T.gain=null; T.playing=false; T.paused=true; T.stopped=false;
    T.pausedAt=Math.max(0,Math.min(cur,s.buffer.duration));
    stopLoop(); updateBtns();
}
function resume(){
    if(!T.paused) return;
    var src = getActiveSource();
    if(!src || !src.buffer){ T.paused = false; updateBtns(); return; }
    var s = T.pausedAt;
    var e = src.buffer.duration;
    T.paused = false;
    play(s, e);
}
function stop(reset){
    T.token=(T.token||0)+1;
    var cur = 0;
    if(T.playing){
        cur = T.startO + (ctx.currentTime - T.startT);
    } else if(T.paused){
        cur = T.pausedAt;
    } else {
        cur = T.markIn || 0;
    }
    if(T.source){ try{T.source.onended=null;T.source.stop();}catch(e){} try{T.source.disconnect();}catch(e){} }
    if(T.gain){ try{T.gain.disconnect();}catch(e){} }
    T.source=null; T.gain=null; T.playing=false;

    if(reset){
        T.stopped = true;
        T.paused  = false;
        T.pausedAt = 0;
    } else {
        T.stopped = false;
        T.paused = true;
        T.pausedAt = Math.max(0, Math.min(cur, getActiveSource() ? getActiveSource().buffer.duration : 0));
    }
    stopLoop(); updateBtns();
}
function loop(){
    var tick=function(){
        if(!T.playing) return;
        redrawPlayheadOnly();
        updateTimecode();
        T.raf=requestAnimationFrame(tick);
    };
    T.raf=requestAnimationFrame(tick);
}
function stopLoop(){
    if(T.raf){ cancelAnimationFrame(T.raf); T.raf=null; }
    redraw(); updateTimecode();
}

function invalidateWaveCache(){
    waveBaseCanvas = null;
    waveBaseKey = '';
}

function jumpPlayerTo(pos){
    var s = getActiveSource();
    if(!s || !s.buffer) return;
    pos = Math.max(0, Math.min(s.buffer.duration, pos));
    T.pausedAt = pos;
    if(T.playing){
        T.playing = false;
        play(pos, s.buffer.duration);
    } else {
        T.paused = true;
        redraw(); updateTimecode(); updateBtns();
    }
}

function initPlayer(){
    var pB=$('btnPlay1'), stB=$('btnStop1');
    pB.addEventListener('click', function(){
        setActiveContext('player');
        if(T.playing) pause();
        else if(T.paused) resume();
        else {
            var s = getActiveSource();
            if(!s || !s.buffer) return;
            play(T.pausedAt, s.buffer.duration);
        }
    });
    stB.addEventListener('click', function(){
        setActiveContext('player');
        stop(true);
    });
    $('btnGotoStart').addEventListener('click', function(){
        var s = getActiveSource();
        if(!s || !s.buffer) return;
        setActiveContext('player');
        jumpPlayerTo(T.markIn);
    });
    $('btnGotoEnd').addEventListener('click', function(){
        var s = getActiveSource();
        if(!s || !s.buffer) return;
        setActiveContext('player');
        jumpPlayerTo(T.markOut);
    });
}

function initWaveInteraction(){
    var cvs = $('canvas1');
    if(!cvs) return;

    var DRAG_START_PX = 8;

    var clickStartX = 0, clickStartY = 0;
    var clickCandidate = false;
    var dropHappened = false;

    cvs.addEventListener('mousedown', function(e){
        var s = getActiveSource();
        if(!s || !s.buffer) return;
        setActiveContext('player');
        if(e.button !== 0) return;

        lastMouseX = e.clientX;
        lastMouseY = e.clientY;

        var r = cvs.getBoundingClientRect();
        var x = e.clientX - r.left;
        var y = e.clientY - r.top;
        var mode = hitTestWave(x, y);

        if(mode === 'in' || mode === 'out' || mode === 'play'){
            T.dragMode = mode;
            T.dragStartX = e.clientX;
            if(mode === 'in') T.dragStartVal = T.markIn;
            else if(mode === 'out') T.dragStartVal = T.markOut;
            else T.dragStartVal = getCurrentPos();
            e.preventDefault();
            return;
        }

        clickStartX = e.clientX;
        clickStartY = e.clientY;
        clickCandidate = true;
        dropHappened = false;

        waveDragActive = false;
        waveDragRange = null;

        if(e.shiftKey){
            var s0 = getActiveSource();
            var sV0 = T.markIn || 0;
            var eV0 = (T.markOut && T.markOut > 0) ? T.markOut : (s0 ? s0.buffer.duration : 0);
            if(s0 && s0.buffer && (eV0 - sV0) >= 0.02){
                clickCandidate = false;
                waveDragActive = true;
                waveDragRange = { markIn: sV0, markOut: eV0, sourceId: s0.id };
                cvs.style.cursor = 'grabbing';
                showDragGhost(lastMouseX, lastMouseY);
                highlightMasterDrop();
                setStatus('Тяните выделение в Мастер… (Shift)');
                e.preventDefault();
                return;
            }
        }

        e.preventDefault();
    });

    cvs.addEventListener('mousemove', function(e){
        lastMouseX = e.clientX;
        lastMouseY = e.clientY;

        var s = getActiveSource();
        if(!s || !s.buffer) return;
        var r = cvs.getBoundingClientRect();
        var x = e.clientX - r.left;
        var y = e.clientY - r.top;

        if(T.dragMode){
            var dur = s.buffer.duration;
            var dx = e.clientX - T.dragStartX;
            var dSec = (dx / r.width) * dur;
            var newVal = T.dragStartVal + dSec;
            if(newVal < 0) newVal = 0;
            if(newVal > dur) newVal = dur;

            if(T.dragMode === 'in'){
                T.markIn = newVal;
                if(T.markIn >= T.markOut){
                    T.markOut = dur;
                    $('lblEnd1').textContent = fmtTime(T.markOut);
                }
                $('lblStart1').textContent = fmtTime(newVal);
            } else if(T.dragMode === 'out'){
                T.markOut = newVal;
                if(T.markOut <= T.markIn){
                    T.markIn = 0;
                    $('lblStart1').textContent = fmtTime(0);
                }
                $('lblEnd1').textContent = fmtTime(newVal);
            } else {
                T.pausedAt = newVal;
                T.paused = true;
                if(T.playing){
                    stop(false);
                    T.paused = true;
                    T.pausedAt = newVal;
                    updateBtns();
                }
            }
            redraw();
            updateTimecode();
            return;
        }

        if(waveDragActive){ return; }

        if(clickCandidate){
            var dxp = e.clientX - clickStartX;
            var dyp = e.clientY - clickStartY;
            var dist2 = dxp*dxp + dyp*dyp;
            if(dist2 > DRAG_START_PX*DRAG_START_PX){
                var s2 = getActiveSource();
                if(s2 && s2.buffer){
                    var sV = T.markIn || 0;
                    var eV = (T.markOut && T.markOut > 0) ? T.markOut : s2.buffer.duration;
                    if(eV - sV >= 0.02){
                        clickCandidate = false;
                        waveDragActive = true;
                        waveDragRange = { markIn: sV, markOut: eV, sourceId: s2.id };
                        cvs.style.cursor = 'grabbing';
                        showDragGhost(lastMouseX, lastMouseY);
                        highlightMasterDrop();
                        setStatus('Тяните выделение в Мастер…');
                        return;
                    }
                }
                clickCandidate = false;
                return;
            }
        }

        var mode = hitTestWave(x, y);
        if(mode === 'in' || mode === 'out' || mode === 'play') cvs.style.cursor = 'ew-resize';
        else cvs.style.cursor = 'pointer';
    });

    document.addEventListener('mouseup', function(e){
        if(T.dragMode){
            T.dragMode = null;
            redraw();
            updateTimecode();
            return;
        }

        if(waveDragActive){
            var overMaster = false;
            var tb = $('blockTimeline');
            if(tb){
                var rtb = tb.getBoundingClientRect();
                if(e.clientX >= rtb.left && e.clientX <= rtb.right &&
                   e.clientY >= rtb.top  && e.clientY <= rtb.bottom){
                    overMaster = true;
                }
            }
            if(overMaster && waveDragRange){
                createFragmentFromRange(waveDragRange);
                dropHappened = true;
            } else {
                setStatus('Перетаскивание отменено');
            }
            waveDragActive = false;
            waveDragRange = null;
            hideDragGhost();
            clearMasterDropHighlight();
            cvs.style.cursor = 'pointer';
            return;
        }

        if(clickCandidate){
            clickCandidate = false;

            var s = getActiveSource();
            if(!s || !s.buffer) return;
            var r = cvs.getBoundingClientRect();
            var xx = e.clientX - r.left;
            var yy = e.clientY - r.top;
            if(xx < 0 || xx > r.width || yy < 0 || yy > r.height) return;

            var t = (xx / r.width) * s.buffer.duration;
            if(t < 0) t = 0;
            if(t > s.buffer.duration) t = s.buffer.duration;

            if(T.playing){
                T.playing = false;
                T.pausedAt = t;
                play(t, s.buffer.duration);
            } else {
                T.pausedAt = t;
                T.paused = true;
            }
            redraw();
            updateTimecode();
        }
    });

    document.addEventListener('mousemove', function(e){
        if(!waveDragActive) return;
        lastMouseX = e.clientX;
        lastMouseY = e.clientY;
        moveDragGhost(e.clientX, e.clientY);
    });

    cvs.addEventListener('mouseleave', function(){
        if(!T.dragMode && !waveDragActive) cvs.style.cursor = 'pointer';
    });
}

/* ===== Drag выделения в МАСТЕР ===== */
var waveDragRange = null;
var waveDragActive = false;
var lastMouseX = 0, lastMouseY = 0;

function highlightMasterDrop(){
    var tb = $('blockTimeline');
    if(tb) tb.classList.add('drop-target');
}
function clearMasterDropHighlight(){
    var tb = $('blockTimeline');
    if(tb) tb.classList.remove('drop-target');
}

function showDragGhost(x, y){
    var g = $('dragGhost');
    if(!g) return;
    g.classList.add('active');
    g.style.left = x + 'px';
    g.style.top  = y + 'px';
}
function moveDragGhost(x, y){
    var g = $('dragGhost');
    if(!g || !g.classList.contains('active')) return;
    g.style.left = x + 'px';
    g.style.top  = y + 'px';
}
function hideDragGhost(){
    var g = $('dragGhost');
    if(g) g.classList.remove('active');
}

function createFragmentFromRange(range){
    var src = findSourceById(range.sourceId);
    if(!src || !src.buffer){
        setStatus('Источник не найден — фрагмент не создан.', true);
        return;
    }
    if(range.markOut - range.markIn < 0.02){
        setStatus('Слишком короткий диапазон для фрагмента.', true);
        return;
    }
    var frag = {
        id: ++fragIdSeq,
        sourceId: src.id,
        srcName: src.name,
        trimStart: range.markIn,
        trimEnd: range.markOut,
        volume: FRAG_VOL_DEFAULT,
        xfadeIn: XFADE.defaultMs / 1000,
        xfadeOut: XFADE.defaultMs / 1000
    };
    pushHistory();
    fragments.push(frag);
    setSelectedFragIds([frag.id]);
    selectionAnchor = frag.id;
    renderTimeline();
    setActiveContext('timeline');
    setStatus('Фрагмент «' + frag.srcName + '» добавлен в Мастер. Всего: ' + fragments.length);
}

/* ===== Фрагменты ===== */
function addFragment(){
    var s = getActiveSource();
    if(!s || !s.buffer){ setStatus('Сначала загрузите и выберите источник', true); return; }
    var sV = T.markIn || 0;
    var eV = (T.markOut && T.markOut > 0) ? T.markOut : s.buffer.duration;
    if(eV - sV < 0.01){ setStatus('Неверный диапазон фрагмента', true); return; }

    var frag = {
        id: ++fragIdSeq,
        sourceId: s.id,
        srcName: s.name,
        trimStart: sV,
        trimEnd: eV,
        volume: FRAG_VOL_DEFAULT,
        xfadeIn: XFADE.defaultMs / 1000,
        xfadeOut: XFADE.defaultMs / 1000
    };
    pushHistory();
    fragments.push(frag);
    setSelectedFragIds([frag.id]);
    selectionAnchor = frag.id;
    renderTimeline();
    setStatus('Фрагмент «' + frag.srcName + '» добавлен. Всего: ' + fragments.length);
}

function fragDuration(f){ return f.trimEnd - f.trimStart; }
function totalDuration(){
    var t = 0;
    for(var i=0;i<fragments.length;i++) t += fragDuration(fragments[i]);
    return t;
}
function setFragVolume(f, v){
    if(v < FRAG_VOL_MIN) v = FRAG_VOL_MIN;
    if(v > FRAG_VOL_MAX) v = FRAG_VOL_MAX;
    f.volume = v;
}

function getEdgeFadeDurations(){
    var fi = EDGE_FADE.enabled ? (EDGE_FADE.inMs/1000) : 0;
    var fo = EDGE_FADE.enabled ? (EDGE_FADE.outMs/1000) : 0;
    if(fragments.length === 0) return { fi: 0, fo: 0 };
    var firstD = fragDuration(fragments[0]);
    var lastD = fragDuration(fragments[fragments.length-1]);
    if(fi > firstD/4) fi = firstD/4;
    if(fo > lastD/4) fo = lastD/4;
    return { fi: fi, fo: fo };
}

function computeTimelinePositions(){
    if(fragments.length === 0) return [];

    if(!XFADE.enabled || XFADE.maxMs <= 0){
        var result = [];
        var cursor = 0;
        for(var i=0;i<fragments.length;i++){
            var d = fragDuration(fragments[i]);
            result.push({ idx: i, fragGlobalStart: cursor, fragGlobalEnd: cursor + d, xIn: 0, xOut: 0 });
            cursor += d;
        }
        return result;
    }

    for(var s=0; s<fragments.length - 1; s++){
        var a = fragments[s].xfadeOut || 0;
        var b = fragments[s+1].xfadeIn || 0;
        var merged = Math.max(a, b);
        var dA = fragDuration(fragments[s]);
        var dB = fragDuration(fragments[s+1]);
        var maxAllowed = Math.min(dA/2, dB/2, XFADE.maxMs/1000);
        if(merged > maxAllowed) merged = maxAllowed;
        fragments[s].xfadeOut = merged;
        fragments[s+1].xfadeIn = merged;
    }
    if(fragments.length > 0){
        fragments[0].xfadeIn = 0;
        fragments[fragments.length-1].xfadeOut = 0;
    }

    var xf = [];
    var cursor2 = 0;
    for(var i=0;i<fragments.length;i++){
        var f = fragments[i];
        var d = fragDuration(f);
        var xIn = Math.max(0, f.xfadeIn || 0);
        var xOut = Math.max(0, f.xfadeOut || 0);
        if(i === 0) xIn = 0;
        if(i === fragments.length-1) xOut = 0;
        if(xIn > d/2) xIn = d/2;
        if(xOut > d/2) xOut = d/2;
        xf.push({ idx: i, fragGlobalStart: cursor2, fragGlobalEnd: cursor2 + d, xIn: xIn, xOut: xOut });
        cursor2 += d - xOut;
    }
    return xf;
}

function totalDurationWithXfade(){
    var xf = computeTimelinePositions();
    if(!xf || xf.length === 0) return totalDuration();
    var last = xf[xf.length-1];
    return last.fragGlobalStart + fragDuration(fragments[xf.length-1]);
}

function pauseTlForEdit(){
    if(!tl.playing) return null;
    var pos = tlCurrentPos();
    tl.token = (tl.token||0)+1;
    tlStopAllSources();
    tl.playing = false;
    tl.paused = true;
    tl.pausePos = Math.max(0, Math.min(totalDurationWithXfade(), pos));
    updateTlBtns();
    updatePlayhead(tl.pausePos);
    return tl.pausePos;
}
function resumeTlAfterEdit(pos){
    if(!tl.paused) return;
    tl.paused = false;
    tlPlay(pos);
}

/* ===== Рендер МАСТЕРА ===== */
function renderTimeline(){
    var track = $('tlTrack');

    if(fragments.length === 0){
        $('tlEmpty').style.display = 'flex';
        $('tlEditor').style.display = 'none';

        tlCancelLoop();
        tl.token = (tl.token || 0) + 1;
        tlStopAllSources();
        tl.playing = false;
        tl.paused = false;
        tl.pausePos = 0;
        tl.startPos = 0;

        var ph = $('tlPlayhead');
        if(ph) ph.style.display = 'none';

        $('btnExport').disabled = true;
        $('tlDelete').disabled = true;
        $('tlPlay').disabled = true;
        $('tlStop').disabled = true;
        $('tlPlay').textContent = '▶ Воспроизвести';
        $('tlStop').textContent = '⏹ Стоп';

        var xfCb = $('xfEnable'); if(xfCb) xfCb.disabled = true;
        var lpCb = $('tlLoop'); if(lpCb) lpCb.disabled = true;

        $('tlPosCur').textContent = '— : — . —';

        updateTimelineCounters();
        updateUndoRedoButtons();
        updateEditButtons();
        var oldF = track.querySelectorAll('.frag');
        for (var r = oldF.length - 1; r >= 0; r--) oldF[r].remove();
        updateCutButton();
        return;
    }

    $('tlEmpty').style.display = 'none';
    $('tlEditor').style.display = 'block';
    $('btnExport').disabled = false;
    $('tlDelete').disabled = (selectedFragIds.length === 0);
    $('tlPlay').disabled = false;
    var xfCbOn = $('xfEnable'); if(xfCbOn) xfCbOn.disabled = false;
    var lpCbOn = $('tlLoop'); if(lpCbOn) lpCbOn.disabled = false;
    updateUndoRedoButtons();

    (function cleanSelection(){
        var alive = [];
        for(var q=0;q<selectedFragIds.length;q++){
            var found = false;
            for(var w=0;w<fragments.length;w++){
                if(fragments[w].id === selectedFragIds[q]){ found = true; break; }
            }
            if(found) alive.push(selectedFragIds[q]);
        }
        selectedFragIds = alive;
    })();

    var oldFrags = track.querySelectorAll('.frag');
    for (var r = oldFrags.length - 1; r >= 0; r--) oldFrags[r].remove();

    var tlPositions = computeTimelinePositions();
    var total = totalDurationWithXfade();

    for(var i=0;i<fragments.length;i++){
        var f = fragments[i];
        var d = fragDuration(f);
        var xInfo = tlPositions[i];
        var nextStart = (i < fragments.length - 1) ? tlPositions[i+1].fragGlobalStart : total;
        var visibleWidth = nextStart - xInfo.fragGlobalStart;
        var wPercent = total > 0 ? (visibleWidth / total) * 100 : 0;

        var buf = getBufferForFrag(f);
        var isMissing = !buf;

        var el = document.createElement('div');
        el.className = 'frag';
        el.classList.add('c' + (f.id % 7));
        if(isMissing) el.classList.add('missing');
        if(isFragSelected(f.id)) el.classList.add('selected');
        el.style.width = wPercent + '%';
        el.dataset.idx = i;
        el.dataset.id  = f.id;

        var cvs = document.createElement('canvas');
        var pxW = Math.max(300, Math.min(4000, Math.round(window.innerWidth * (wPercent/100) * 1.5)));
        cvs.width = pxW;
        cvs.height = 220;
        el.appendChild(cvs);

        if(!isMissing){
            var volLine = document.createElement('div');
            volLine.className = 'frag-volume-line';
            volLine.dataset.idx = i;
            var v = (typeof f.volume === 'number') ? f.volume : FRAG_VOL_DEFAULT;
            var topPercent = 100 - (v / FRAG_VOL_MAX) * 100;
            if(topPercent < 0) topPercent = 0;
            if(topPercent > 100) topPercent = 100;
            volLine.style.top = 'calc(' + topPercent + '% - 1px)';
            el.appendChild(volLine);

            var volLbl = document.createElement('div');
            volLbl.className = 'frag-vol-label';
            volLbl.dataset.idx = i;
            volLbl.textContent = Math.round(v * 100) + '%';
            var lblTop = topPercent - 4;
            if(lblTop < 0) lblTop = 0;
            if(lblTop > 90) lblTop = 90;
            volLbl.style.top = lblTop + '%';
            el.appendChild(volLbl);
        }

        var nm = document.createElement('div');
        nm.className = 'frag-name';
        nm.textContent = f.srcName + (isMissing ? '  ⚠' : '');
        nm.title = isMissing ? (f.srcName + ' — источник не загружен') : f.srcName;
        el.appendChild(nm);

        if(!isMissing){
            if(XFADE.enabled && i > 0 && (f.xfadeIn || 0) > 0.001 && d > 0){
                var xIn = Math.min(f.xfadeIn, d/2, fragDuration(fragments[i-1])/2);
                if(xIn > 0.001){
                    var zoneIn = document.createElement('div');
                    zoneIn.className = 'frag-xfade xfade-left';
                    zoneIn.dataset.idx = i;
                    zoneIn.dataset.side = 'left';
                    zoneIn.style.width = ((xIn / visibleWidth) * 100) + '%';
                    var durIn = document.createElement('span');
                    durIn.className = 'xfade-dur';
                    durIn.textContent = Math.round(xIn*1000) + 'мс';
                    zoneIn.appendChild(durIn);
                    el.appendChild(zoneIn);
                }
            }
            if(XFADE.enabled && i < fragments.length-1 && (f.xfadeOut || 0) > 0.001 && d > 0){
                var xOut = Math.min(f.xfadeOut, d/2, fragDuration(fragments[i+1])/2);
                if(xOut > 0.001){
                    var zoneOut = document.createElement('div');
                    zoneOut.className = 'frag-xfade xfade-right';
                    zoneOut.dataset.idx = i;
                    zoneOut.dataset.side = 'right';
                    zoneOut.style.width = ((xOut / visibleWidth) * 100) + '%';
                    var durOut = document.createElement('span');
                    durOut.className = 'xfade-dur';
                    durOut.textContent = Math.round(xOut*1000) + 'мс';
                    zoneOut.appendChild(durOut);
                    el.appendChild(zoneOut);
                }
            }

            var hL = document.createElement('div');
            hL.className = 'frag-handle left';
            hL.dataset.idx = i; hL.dataset.side = 'left';
            el.appendChild(hL);

            var hR = document.createElement('div');
            hR.className = 'frag-handle right';
            hR.dataset.idx = i; hR.dataset.side = 'right';
            el.appendChild(hR);
        }

        track.appendChild(el);
        if(!isMissing) drawFragWave(cvs, f, buf);
    }

    attachAllHandlers();
    refreshSelectionUI();
    updateCutButton();
}

function drawFragWave(cvs, f, buf){
    if(!buf) return;
    var hz = buf.sampleRate;
    var startSample = Math.max(0, Math.floor(f.trimStart * hz));
    var endSample   = Math.min(buf.length, Math.floor(f.trimEnd * hz));
    var len = endSample - startSample;
    if(len <= 0) return;

    var w = cvs.width, h = cvs.height;
    var g = cvs.getContext('2d');
    g.clearRect(0,0,w,h);

    var mid = h/2;
    var chs = buf.numberOfChannels;
    var mono = new Float32Array(len);
    for(var c=0;c<chs;c++){
        var data = buf.getChannelData(c);
        for(var i=0;i<len;i++) mono[i] += (data[startSample + i] || 0)/chs;
    }

    var step = Math.max(1, Math.ceil(len/w));
    g.strokeStyle = '#00adb5'; g.lineWidth = 1.5; g.beginPath();
    for(var x=0;x<w;x++){
        var s0 = Math.floor(x*step), e0 = Math.min(s0+step, len);
        var mn=1, mx=-1;
        for(var j=s0;j<e0;j++){ var v = mono[j]; if(v<mn) mn=v; if(v>mx) mx=v; }
        if(mn>mx){ mn=0; mx=0; }
        g.moveTo(x, (1+mn)*mid); g.lineTo(x, (1+mx)*mid);
    }
    g.stroke();
}

function attachAllHandlers(){
    var track = $('tlTrack');
    var items = track.querySelectorAll('.frag');
    for(var i=0;i<items.length;i++){
        attachSelection(items[i]);
        if(!items[i].classList.contains('missing')){
            attachDragHandlers(items[i], parseInt(items[i].dataset.idx,10));
            var handles = items[i].querySelectorAll('.frag-handle');
            for(var h=0;h<handles.length;h++) attachTrimHandlers(handles[h]);
        }
    }
    var volLines = track.querySelectorAll('.frag-volume-line');
    for(var j=0;j<volLines.length;j++) attachVolumeHandlers(volLines[j]);
    var xfZones = track.querySelectorAll('.frag-xfade');
    for(var k=0;k<xfZones.length;k++) attachXfadeHandlers(xfZones[k]);
}

function attachVolumeHandlers(volLine){
    volLine.addEventListener('mousedown', function(e){
        e.preventDefault();
        e.stopPropagation();
        var idx = parseInt(volLine.dataset.idx, 10);
        var f = fragments[idx]; if(!f) return;
        var el = volLine.parentNode;
        var rect = el.getBoundingClientRect();
        var startY = e.clientY;
        var startVol = (typeof f.volume === 'number') ? f.volume : FRAG_VOL_DEFAULT;
        var histPushed = false;
        volLine.classList.add('dragging');

        function applyVolumeFromEvent(ev){
            var dy = startY - ev.clientY;
            var dNorm = dy / rect.height;
            var newVol = startVol + dNorm * FRAG_VOL_MAX;
            setFragVolume(f, newVol);
            var topPercent = 100 - (f.volume / FRAG_VOL_MAX) * 100;
            if(topPercent < 0) topPercent = 0;
            if(topPercent > 100) topPercent = 100;
            volLine.style.top = 'calc(' + topPercent + '% - 1px)';
            var lbl = el.querySelector('.frag-vol-label');
            if(lbl){
                lbl.textContent = Math.round(f.volume * 100) + '%';
                var lblTop = topPercent - 4;
                if(lblTop < 0) lblTop = 0;
                if(lblTop > 90) lblTop = 90;
                lbl.style.top = lblTop + '%';
            }
            updateLiveFragGains(f.id, f.volume);
        }

        function onMove(ev){
            if(!histPushed && Math.abs(startY - ev.clientY) > 1){ pushHistory(); histPushed = true; }
            applyVolumeFromEvent(ev);
        }
        function onUp(){
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            volLine.classList.remove('dragging');
            setActiveContext('timeline');
            setSelectedFragIds([f.id]);
            selectionAnchor = f.id;
            var all = document.querySelectorAll('.frag');
            for(var i=0;i<all.length;i++) all[i].classList.remove('selected');
            el.classList.add('selected');
            $('tlDelete').disabled = false;
            updateEditButtons();
            setStatus('Фрагмент «' + f.srcName + '»: громкость ' + Math.round(f.volume * 100) + '%');
        }
        applyVolumeFromEvent(e);
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    });
}

function attachXfadeHandlers(zone){
    zone.addEventListener('mousedown', function(e){
        e.preventDefault();
        e.stopPropagation();
        setActiveContext('timeline');
        var idx = parseInt(zone.dataset.idx, 10);
        var side = zone.dataset.side;
        var f = fragments[idx]; if(!f) return;
        var histPushed = false;
        var editPos = pauseTlForEdit();
        var el = zone.parentNode;
        var rect = el.getBoundingClientRect();
        var tlPositions = computeTimelinePositions();
        var total = totalDurationWithXfade();
        var nextStart = (idx < fragments.length-1) ? tlPositions[idx+1].fragGlobalStart : total;
        var visibleDur = nextStart - tlPositions[idx].fragGlobalStart;
        var pxPerSec = visibleDur > 0 ? rect.width / visibleDur : 0;
        var startX = e.clientX;
        var startVal = side === 'left' ? (f.xfadeIn || 0) : (f.xfadeOut || 0);
        zone.classList.add('dragging');

        function onMove(ev){
            if(!histPushed && Math.abs(ev.clientX - startX) > 1){ pushHistory(); histPushed = true; }
            var dx = ev.clientX - startX;
            var dSec = (side === 'left') ? (dx / pxPerSec) : (-dx / pxPerSec);
            var newVal = startVal + dSec;
            if(newVal < 0) newVal = 0;
            var maxBySide = XFADE.maxMs / 1000;
            var d = fragDuration(f);
            if(newVal > d/2) newVal = d/2;
            if(side === 'left' && idx > 0){
                var prevD = fragDuration(fragments[idx-1]);
                if(newVal > prevD/2) newVal = prevD/2;
            }
            if(side === 'right' && idx < fragments.length-1){
                var nextD = fragDuration(fragments[idx+1]);
                if(newVal > nextD/2) newVal = nextD/2;
            }
            if(newVal > maxBySide) newVal = maxBySide;

            if(side === 'left') f.xfadeIn = newVal; else f.xfadeOut = newVal;
            if(side === 'left' && idx > 0) fragments[idx-1].xfadeOut = newVal;
            if(side === 'right' && idx < fragments.length-1) fragments[idx+1].xfadeIn = newVal;

            if(visibleDur > 0) zone.style.width = ((newVal / visibleDur) * 100) + '%';
            var durEl = zone.querySelector('.xfade-dur');
            if(durEl) durEl.textContent = Math.round(newVal*1000) + 'мс';
        }
        function onUp(){
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            zone.classList.remove('dragging');
            var v = side === 'left' ? f.xfadeIn : f.xfadeOut;
            setStatus('Кроссфейд: ' + Math.round((v||0)*1000) + ' мс');
            if(editPos !== null) resumeTlAfterEdit(editPos);
            renderTimeline();
        }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    });
}

function refreshSelectionUI(){
    var all = $('tlTrack').querySelectorAll('.frag');
    for(var i=0;i<all.length;i++){
        var fid = parseInt(all[i].dataset.id, 10);
        if(isFragSelected(fid)) all[i].classList.add('selected');
        else all[i].classList.remove('selected');
    }
    $('tlDelete').disabled = (selectedFragIds.length === 0);
    updateEditButtons();
    updateTimelineCounters();
}

function attachSelection(el){
    el.addEventListener('mousedown', function(e){
        if(e.target.classList.contains('frag-handle')) return;
        if(e.target.classList.contains('frag-volume-line')) return;
        if(e.target.classList.contains('frag-xfade')) return;
        if(e.button !== 0) return;
        setActiveContext('timeline');
        var id = parseInt(el.dataset.id, 10);

        var ctrl  = e.ctrlKey || e.metaKey;
        var shift = e.shiftKey;

        if(shift){
            var anchorId = selectionAnchor;
            if(anchorId === null){
                setSelectedFragIds([id]);
                selectionAnchor = id;
            } else {
                var idxA = -1, idxB = -1;
                for(var i=0;i<fragments.length;i++){
                    if(fragments[i].id === anchorId) idxA = i;
                    if(fragments[i].id === id)       idxB = i;
                }
                if(idxA === -1 || idxB === -1){
                    setSelectedFragIds([id]);
                    selectionAnchor = id;
                } else {
                    var from = Math.min(idxA, idxB);
                    var to   = Math.max(idxA, idxB);
                    var ids = [];
                    for(var k=from;k<=to;k++) ids.push(fragments[k].id);
                    if(ctrl){
                        for(var j=0;j<selectedFragIds.length;j++){
                            if(ids.indexOf(selectedFragIds[j]) === -1) ids.push(selectedFragIds[j]);
                        }
                    }
                    setSelectedFragIds(ids);
                }
            }
        } else if(ctrl){
            toggleFragSelection(id);
            selectionAnchor = id;
        } else {
            setSelectedFragIds([id]);
            selectionAnchor = id;
        }

        refreshSelectionUI();
    });
}

var dragEditPos = null;

function attachDragHandlers(el, idx){
    el.draggable = true;
    el.addEventListener('dragstart', function(e){
        if(e.target.classList.contains('frag-handle')){ e.preventDefault(); return; }
        if(e.target.classList.contains('frag-volume-line')){ e.preventDefault(); return; }
        if(e.target.classList.contains('frag-xfade')){ e.preventDefault(); return; }
        el.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(idx));
        dragEditPos = null;
        dragEditPos = pauseTlForEdit();
    });
    el.addEventListener('dragend', function(){
        el.classList.remove('dragging');
        var all = document.querySelectorAll('.frag');
        for(var i=0;i<all.length;i++) all[i].classList.remove('dragover-left','dragover-right');
        if(dragEditPos !== null) resumeTlAfterEdit(dragEditPos);
        dragEditPos = null;
    });
    el.addEventListener('dragover', function(e){
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        var rect = el.getBoundingClientRect();
        var midX = rect.left + rect.width/2;
        el.classList.remove('dragover-left','dragover-right');
        if(e.clientX < midX) el.classList.add('dragover-left');
        else el.classList.add('dragover-right');
    });
    el.addEventListener('dragleave', function(){ el.classList.remove('dragover-left','dragover-right'); });
    el.addEventListener('drop', function(e){
        e.preventDefault();
        el.classList.remove('dragover-left','dragover-right');
        var fromIdx = parseInt(e.dataTransfer.getData('text/plain'),10);
        var toIdx = idx;
        if(isNaN(fromIdx) || fromIdx === toIdx) return;
        var rect = el.getBoundingClientRect();
        var before = (e.clientX < rect.left + rect.width/2);
        pushHistory();
        var moved = fragments.splice(fromIdx,1)[0];
        var insertAt;
        if(fromIdx < toIdx){ insertAt = before ? toIdx - 1 : toIdx; }
        else { insertAt = before ? toIdx : toIdx + 1; }
        fragments.splice(insertAt, 0, moved);
        renderTimeline();
        setStatus('Фрагмент «' + moved.srcName + '» перемещён');
        dragEditPos = null;
    });
}

var fragClipboard = [];

function attachTrimHandlers(handle){
    var idx = parseInt(handle.dataset.idx, 10);
    var side = handle.dataset.side;

    handle.addEventListener('mousedown', function(e){
        e.preventDefault();
        e.stopPropagation();
        setActiveContext('timeline');
        var f = fragments[idx]; if(!f) return;
        var buf = getBufferForFrag(f); if(!buf) return;

        var editPos = pauseTlForEdit();
        var track = $('tlTrack');
        var trackRect = track.getBoundingClientRect();
        var total = totalDurationWithXfade(); if(total <= 0) return;
        var secPerPx = total / trackRect.width;
        var startX = e.clientX;
        pushHistory();
        var origTrimStart = f.trimStart;
        var origTrimEnd   = f.trimEnd;

        function onMove(ev){
            var dx = ev.clientX - startX;
            var dSec = dx * secPerPx;

            if(side === 'left'){
                var newStart = origTrimStart + dSec;
                if(newStart < 0) newStart = 0;
                if(newStart > f.trimEnd - 0.05) newStart = f.trimEnd - 0.05;
                f.trimStart = newStart;
            } else {
                var newEnd = origTrimEnd + dSec;
                if(newEnd > buf.duration) newEnd = buf.duration;
                if(newEnd < f.trimStart + 0.05) newEnd = f.trimStart + 0.05;
                f.trimEnd = newEnd;
            }
            var cvs = handle.parentNode.querySelector('canvas');
            if(cvs) drawFragWave(cvs, f, buf);
        }
        function onUp(){
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            setStatus('Фрагмент «' + f.srcName + '»: ' + fmtTime(fragDuration(f)));
            if(editPos !== null) resumeTlAfterEdit(editPos);
            renderTimeline();
        }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    });
}

function deleteSelectedFragments(){
    if(selectedFragIds.length === 0) return;
    var toRemove = getSelectedFragIndexes();
    if(toRemove.length === 0){ clearSelection(); $('tlDelete').disabled = true; return; }

    if(tl.playing){
        tlStop(true);
    }

    pushHistory();
    for(var i=toRemove.length-1;i>=0;i--){
        fragments.splice(toRemove[i], 1);
    }
    var neighborIdx = toRemove[0] - 1;
    if(neighborIdx < 0) neighborIdx = 0;
    if(fragments.length === 0){
        clearSelection();
        $('tlDelete').disabled = true;
    } else {
        if(neighborIdx >= fragments.length) neighborIdx = fragments.length - 1;
        setSelectedFragIds([fragments[neighborIdx].id]);
        selectionAnchor = fragments[neighborIdx].id;
    }

    normalizeXfadesAtSeams();

    renderTimeline();
    setStatus('Удалено фрагментов: ' + toRemove.length + '. Всего: ' + fragments.length);
}

function findFragIndexUnderPlayhead(){
    if(fragments.length === 0) return -1;
    var tlPositions = computeTimelinePositions();
    var pos = tlCurrentPos();
    var minGap = 0.02;
    for(var i=0;i<fragments.length;i++){
        if(!getBufferForFrag(fragments[i])) continue;
        var xInfo = tlPositions[i];
        if(pos > xInfo.fragGlobalStart + minGap && pos < xInfo.fragGlobalEnd - minGap){
            return i;
        }
    }
    return -1;
}

function updateCutButton(){
    var btn = $('tlCut');
    if(!btn) return;
    btn.disabled = (findFragIndexUnderPlayhead() === -1);
}

function cutSelectedFragment(){
    setActiveContext('timeline');
    if(fragments.length === 0){ setStatus('Мастер пуст', true); return; }

    var minGap = 0.02;
    var wasPlaying = tl.playing;

    var idx = -1;
    var localOffsetInFrag = 0;

    var firstSelectedId = getFirstSelectedFragId();
    if(firstSelectedId !== null){
        var posSel = tlCurrentPos();
        var tlPosSel = computeTimelinePositions();
        var idxSel = -1;
        for(var i=0;i<fragments.length;i++){
            if(fragments[i].id === firstSelectedId){ idxSel = i; break; }
        }
        if(idxSel !== -1 && getBufferForFrag(fragments[idxSel])){
            var xSel = tlPosSel[idxSel];
            if(posSel > xSel.fragGlobalStart + minGap && posSel < xSel.fragGlobalEnd - minGap){
                idx = idxSel;
                localOffsetInFrag = posSel - xSel.fragGlobalStart;
            }
        }
    }
    if(idx === -1){
        var pos0 = tlCurrentPos();
        var tlPos0 = computeTimelinePositions();
        for(var i=0;i<fragments.length;i++){
            if(!getBufferForFrag(fragments[i])) continue;
            var xi = tlPos0[i];
            if(pos0 > xi.fragGlobalStart + minGap && pos0 < xi.fragGlobalEnd - minGap){
                idx = i;
                localOffsetInFrag = pos0 - xi.fragGlobalStart;
                break;
            }
        }
    }
    if(idx === -1){
        setStatus('Плейхед не над фрагментом', true);
        return;
    }

    var f = fragments[idx];
    var buf = getBufferForFrag(f);
    if(!buf){ setStatus('Источник фрагмента не загружен', true); return; }

    var tlPositions = computeTimelinePositions();
    var xInfo = tlPositions[idx];
    var pos = xInfo.fragGlobalStart + localOffsetInFrag;

    if(pos <= xInfo.fragGlobalStart + minGap || pos >= xInfo.fragGlobalEnd - minGap){
        setStatus('Плейхед должен находиться внутри фрагмента', true);
        return;
    }

    var cutTime = f.trimStart + localOffsetInFrag;

    if(cutTime <= f.trimStart + 0.01 || cutTime >= f.trimEnd - 0.01){
        setStatus('Точка разреза слишком близко к краю', true);
        return;
    }

    tl.pausePos = pos;
    updatePlayhead(pos);

    pushHistory();

    if(wasPlaying) pauseTlForEdit();

    var leftDur  = cutTime - f.trimStart;
    var rightDur = f.trimEnd - cutTime;
    var xfDef = XFADE.defaultMs / 1000;
    if(xfDef > leftDur / 2)  xfDef = leftDur / 2;
    if(xfDef > rightDur / 2) xfDef = rightDur / 2;
    if(xfDef < 0) xfDef = 0;

    var leftFrag = {
        id: f.id,
        sourceId: f.sourceId,
        srcName: f.srcName,
        trimStart: f.trimStart,
        trimEnd: cutTime,
        volume: f.volume,
        xfadeIn: f.xfadeIn,
        xfadeOut: xfDef
    };

    var rightFrag = {
        id: ++fragIdSeq,
        sourceId: f.sourceId,
        srcName: f.srcName,
        trimStart: cutTime,
        trimEnd: f.trimEnd,
        volume: f.volume,
        xfadeIn: xfDef,
        xfadeOut: f.xfadeOut
    };

    fragments.splice(idx, 1, leftFrag, rightFrag);
    setSelectedFragIds([rightFrag.id]);
    selectionAnchor = rightFrag.id;

    renderTimeline();
    updateCutButton();
    setStatus('Фрагмент «' + f.srcName + '» разрезан в ' + fmtTime(pos));

    if(wasPlaying) resumeTlAfterEdit(pos);
}

/* ===== Буфер обмена фрагментов ===== */
function getSelectedFragIndex(){
    var id = getFirstSelectedFragId();
    if(id === null) return -1;
    for(var i=0;i<fragments.length;i++){
        if(fragments[i].id === id) return i;
    }
    return -1;
}

function snapFragForClipboard(f){
    return {
        sourceId: f.sourceId,
        srcName: f.srcName,
        trimStart: f.trimStart,
        trimEnd: f.trimEnd,
        volume: f.volume,
        xfadeIn: f.xfadeIn,
        xfadeOut: f.xfadeOut
    };
}

function getSortedSelectedIndexes(){
    var idxs = getSelectedFragIndexes();
    idxs.sort(function(a,b){ return a-b; });
    return idxs;
}

function normalizeXfadesAtSeams(){
    if(fragments.length === 0) return;
    if(!XFADE.enabled || XFADE.maxMs <= 0){
        for(var i=0;i<fragments.length;i++){
            fragments[i].xfadeIn = 0;
            fragments[i].xfadeOut = 0;
        }
        return;
    }
    for(var s=0; s<fragments.length - 1; s++){
        var a = fragments[s].xfadeOut || 0;
        var b = fragments[s+1].xfadeIn || 0;
        var merged = Math.max(a, b);
        var dA = fragDuration(fragments[s]);
        var dB = fragDuration(fragments[s+1]);
        var maxAllowed = Math.min(dA/2, dB/2, XFADE.maxMs/1000);
        if(merged <= 0.0001 && XFADE.enabled){
            merged = Math.min(XFADE.defaultMs/1000, maxAllowed);
        }
        if(merged > maxAllowed) merged = maxAllowed;
        fragments[s].xfadeOut = merged;
        fragments[s+1].xfadeIn = merged;
    }
    fragments[0].xfadeIn = 0;
    fragments[fragments.length-1].xfadeOut = 0;
}

function copySelectedFragments(){
    if(selectedFragIds.length === 0){ setStatus('Выделите фрагменты для копирования', true); return; }
    var idxs = getSortedSelectedIndexes();
    fragClipboard = [];
    for(var i=0;i<idxs.length;i++){
        fragClipboard.push(snapFragForClipboard(fragments[idxs[i]]));
    }
    updateEditButtons();
    setStatus('Скопировано фрагментов: ' + fragClipboard.length);
}

function cutSelectedFragmentsToClipboard(){
    if(selectedFragIds.length === 0){ setStatus('Выделите фрагменты для вырезания', true); return; }
    var idxs = getSortedSelectedIndexes();
    fragClipboard = [];
    for(var i=0;i<idxs.length;i++){
        fragClipboard.push(snapFragForClipboard(fragments[idxs[i]]));
    }

    if(tl.playing){
        tlStop(true);
    }

    pushHistory();
    for(var j=idxs.length-1;j>=0;j--){
        fragments.splice(idxs[j], 1);
    }
    var neighborIdx = idxs[0] - 1;
    if(neighborIdx < 0) neighborIdx = 0;
    if(fragments.length === 0){
        clearSelection();
    } else {
        if(neighborIdx >= fragments.length) neighborIdx = fragments.length - 1;
        setSelectedFragIds([fragments[neighborIdx].id]);
        selectionAnchor = fragments[neighborIdx].id;
    }

    normalizeXfadesAtSeams();

    renderTimeline();
    setStatus('Вырезано фрагментов: ' + fragClipboard.length);
}

function pasteFragmentsFromClipboard(){
    if(!fragClipboard || fragClipboard.length === 0){
        setStatus('Буфер пуст — сначала скопируйте фрагменты (Ctrl+C)', true);
        return;
    }

    var pasteAt;
    var lastId = getLastSelectedFragId();
    if(lastId === null){
        pasteAt = fragments.length;
    } else {
        var lastIdx = -1;
        for(var i=0;i<fragments.length;i++){
            if(fragments[i].id === lastId){ lastIdx = i; break; }
        }
        pasteAt = (lastIdx === -1) ? fragments.length : lastIdx + 1;
    }

    if(tl.playing){
        tlStop(true);
    }

    pushHistory();
    var newIds = [];
    for(var k=0;k<fragClipboard.length;k++){
        var src = fragClipboard[k];
        var newFrag = {
            id: ++fragIdSeq,
            sourceId: src.sourceId,
            srcName: src.srcName,
            trimStart: src.trimStart,
            trimEnd: src.trimEnd,
            volume: src.volume,
            xfadeIn: src.xfadeIn,
            xfadeOut: src.xfadeOut
        };
        fragments.splice(pasteAt + k, 0, newFrag);
        newIds.push(newFrag.id);
    }

    normalizeXfadesAtSeams();

    setSelectedFragIds(newIds);
    selectionAnchor = newIds[0];
    renderTimeline();
    setStatus('Вставлено фрагментов: ' + newIds.length);
}

function duplicateSelectedFragments(){
    if(selectedFragIds.length === 0){ setStatus('Выделите фрагменты для дублирования', true); return; }
    var idxs = getSortedSelectedIndexes();

    if(tl.playing){
        tlStop(true);
    }

    pushHistory();
    var newIds = [];
    var insertAt = idxs[idxs.length-1] + 1;
    for(var i=0;i<idxs.length;i++){
        var f = fragments[idxs[i]];
        var newFrag = {
            id: ++fragIdSeq,
            sourceId: f.sourceId,
            srcName: f.srcName,
            trimStart: f.trimStart,
            trimEnd: f.trimEnd,
            volume: f.volume,
            xfadeIn: f.xfadeIn,
            xfadeOut: f.xfadeOut
        };
        fragments.splice(insertAt + i, 0, newFrag);
        newIds.push(newFrag.id);
    }

    normalizeXfadesAtSeams();

    setSelectedFragIds(newIds);
    selectionAnchor = newIds[0];
    renderTimeline();
    setStatus('Дублировано фрагментов: ' + newIds.length);
}

/* ===== Undo / Redo ===== */
var undoStack = [];
var redoStack = [];
var MAX_HISTORY = 50;

function snapshotFragments(){
    var snap = [];
    for(var i=0;i<fragments.length;i++){
        var f = fragments[i];
        snap.push({
            id: f.id,
            sourceId: f.sourceId,
            srcName: f.srcName,
            trimStart: f.trimStart,
            trimEnd: f.trimEnd,
            volume: f.volume,
            xfadeIn: f.xfadeIn,
            xfadeOut: f.xfadeOut
        });
    }
    return snap;
}

function pushHistory(){
    undoStack.push({
        frags: snapshotFragments(),
        fragIdSeq: fragIdSeq,
        selectedFragIds: selectedFragIds.slice(),
        selectionAnchor: selectionAnchor,
        xfadeEnabled: XFADE.enabled
    });
    if(undoStack.length > MAX_HISTORY) undoStack.shift();
    redoStack = [];
    updateUndoRedoButtons();
}

function restoreSnapshot(snap){
    if(tl.playing){
        tlStop(true);
    }

    fragments = [];
    for(var i=0;i<snap.frags.length;i++){
        var s = snap.frags[i];
        fragments.push({
            id: s.id,
            sourceId: s.sourceId,
            srcName: s.srcName,
            trimStart: s.trimStart,
            trimEnd: s.trimEnd,
            volume: s.volume,
            xfadeIn: s.xfadeIn,
            xfadeOut: s.xfadeOut
        });
    }
    fragIdSeq = snap.fragIdSeq;
    selectedFragIds = (snap.selectedFragIds || []).slice();
    selectionAnchor = snap.selectionAnchor || null;
    XFADE.enabled = snap.xfadeEnabled;
    var cb = $('xfEnable');
    if(cb) cb.checked = XFADE.enabled;

    normalizeXfadesAtSeams();

    renderTimeline();
    $('tlDelete').disabled = (selectedFragIds.length === 0);
    updateEditButtons();
}

function undo(){
    if(undoStack.length === 0) return;
    redoStack.push({ frags: snapshotFragments(), fragIdSeq: fragIdSeq, selectedFragIds: selectedFragIds.slice(), selectionAnchor: selectionAnchor, xfadeEnabled: XFADE.enabled });
    var snap = undoStack.pop();
    restoreSnapshot(snap);
    updateUndoRedoButtons();
    setStatus('Действие отменено');
}
function redo(){
    if(redoStack.length === 0) return;
    undoStack.push({ frags: snapshotFragments(), fragIdSeq: fragIdSeq, selectedFragIds: selectedFragIds.slice(), selectionAnchor: selectionAnchor, xfadeEnabled: XFADE.enabled });
    var snap = redoStack.pop();
    restoreSnapshot(snap);
    updateUndoRedoButtons();
    setStatus('Действие возвращено');
}

function updateUndoRedoButtons(){
    var bU = $('btnUndo'), bR = $('btnRedo');
    if(bU) bU.disabled = (undoStack.length === 0);
    if(bR) bR.disabled = (redoStack.length === 0);
}

function updateEditButtons(){
    var bC = $('tlCopy'), bP = $('tlPaste');
    if(bC) bC.disabled = (selectedFragIds.length === 0);
    if(bP) bP.disabled = (!fragClipboard || fragClipboard.length === 0);
}
function onUndoRedoKey(e){
    if(isHelpOpen()) return;
    if(!(e.ctrlKey || e.metaKey)) return;
    if(isEditable(e.target)) return;
    var code = e.code;
    if(code === 'KeyZ' && !e.shiftKey){ e.preventDefault(); undo(); return; }
    if((code === 'KeyZ' && e.shiftKey) || code === 'KeyY'){ e.preventDefault(); redo(); return; }

    if(activeContext !== 'timeline') return;

    if(code === 'KeyA'){ e.preventDefault(); selectAllFragments(); return; }
    if(code === 'KeyC'){ e.preventDefault(); copySelectedFragments(); return; }
    if(code === 'KeyX'){ e.preventDefault(); cutSelectedFragmentsToClipboard(); return; }
    if(code === 'KeyV'){ e.preventDefault(); pasteFragmentsFromClipboard(); return; }
    if(code === 'KeyD'){ e.preventDefault(); duplicateSelectedFragments(); return; }
}

/* ===== Клавиатура ===== */
var shiftHeld = false;
document.addEventListener('keydown', function(e){ shiftHeld = e.shiftKey; });
document.addEventListener('keyup',   function(e){ shiftHeld = e.shiftKey; });

function isEditable(el){
    if(!el) return false;
    var tg=el.tagName;
    if(tg==='INPUT'||tg==='TEXTAREA'||tg==='SELECT') return true;
    if(el.isContentEditable) return true;
    if(el.classList && el.classList.contains('feedback-toggle')) return true;
    return false;
}

function onKey(e){
    if(isHelpOpen()) return;
    if(isEditable(e.target)) return;
    if(e.ctrlKey || e.metaKey || e.altKey) return;
    var k=e.key;

    if(k===' '||k==='k'||k==='K'||k==='л'||k==='Л'){
        e.preventDefault();
        if(activeContext === 'timeline'){
            if(fragments.length === 0) return;
            if(tl.playing) tlPause();
            else if(tl.paused) tlResume();
            else tlPlay();
            return;
        }
        var s = getActiveSource();
        if(!s || !s.buffer) return;
        if(T.playing) pause();
        else if(T.paused) resume();
        else play(T.pausedAt, s.buffer.duration);
        return;
    }
    if(k==='j'||k==='J'||k==='о'||k==='О'){
        e.preventDefault();
        if(activeContext === 'timeline'){ if(fragments.length === 0) return; tlPlay(0); return; }
        if(!getActiveSource() || !getActiveSource().buffer) return;
        play(T.markIn, T.markOut);
        return;
    }
    if(k==='l'||k==='L'||k==='д'||k==='Д'){
        e.preventDefault();
        if(activeContext === 'timeline'){ tlStop(true); return; }
        stop(true);
        return;
    }
    if(k==='ArrowLeft' || k==='ArrowRight'){
        e.preventDefault();
        if(activeContext === 'timeline'){
            if(fragments.length === 0) return;
            tlSeekBy(k==='ArrowLeft' ? -1 : 1);
            return;
        }
        seek(k==='ArrowLeft' ? -1 : 1);
        return;
    }
    if(k==='Home'){
        e.preventDefault();
        if(activeContext === 'timeline'){
            if(fragments.length === 0) return;
            if(tl.playing){ tlPlay(0); }
            else { tl.paused = true; tl.pausePos = 0; updatePlayhead(0); updateTlBtns(); }
            return;
        }
        var s = getActiveSource();
        if(!s || !s.buffer) return;
        jumpPlayerTo(0);
        return;
    }
    if(k==='i'||k==='I'||k==='ш'||k==='Ш'){
        e.preventDefault();
        markPoint('start');
        return;
    }
    if(k==='o'||k==='O'||k==='щ'||k==='Щ'){
        e.preventDefault();
        markPoint('end');
        return;
    }

    if(k==='p' || k==='P' || k==='з' || k==='З'){
        e.preventDefault();
        addFragment();
        return;
    }
    if(k==='+' || k==='=' || k==='-' || k==='_'){
        if(activeContext !== 'timeline') return;
        if(selectedFragIds.length === 0) return;
        e.preventDefault();
        var f = null;
        var firstId = getFirstSelectedFragId();
        for(var i=0;i<fragments.length;i++){ if(fragments[i].id === firstId){ f = fragments[i]; break; } }
        if(!f) return;
        var delta = (k==='+' || k==='=') ? 0.05 : -0.05;
        if(shiftHeld) delta *= 5;
        pushHistory();
        setFragVolume(f, (f.volume || 1.0) + delta);
        renderTimeline();
        updateLiveFragGains(f.id, f.volume);
        setStatus('Фрагмент «' + f.srcName + '»: ' + Math.round(f.volume*100) + '%');
    }
}

function onTlKey(e){
    if(isHelpOpen()) return;
    if(isEditable(e.target)) return;
    if(e.ctrlKey || e.metaKey || e.altKey) return;
    if(e.key === 'Escape'){
        if(selectedFragIds.length > 0){
            e.preventDefault();
            clearSelection();
            refreshSelectionUI();
            setStatus('Выделение снято');
        }
        return;
    }
    if(e.key === 'Delete' || e.key === 'Backspace'){
        if(activeContext === 'player'){
            if(e.key !== 'Delete') return;
            var s = getActiveSource();
            if(s && s.buffer){
                e.preventDefault();
                removeActiveSource();
            }
            return;
        }
        if(selectedFragIds.length > 0){ e.preventDefault(); deleteSelectedFragments(); }
        return;
    }
    if(e.key === 'c' || e.key === 'C' || e.key === 'с' || e.key === 'С'){
        e.preventDefault();
        cutSelectedFragment();
    }
}

function seek(direction){
    var s = getActiveSource();
    if(!s || !s.buffer) return;
    var cur = getCurrentPos();
    var step;
    if(T.playing){ step = shiftHeld ? 0.1 : 5.0; }
    else { step = shiftHeld ? 0.01 : 0.1; }
    var next = Math.max(0, Math.min(s.buffer.duration, cur + direction*step));
    if(T.playing){
        play(next, s.buffer.duration);
    } else {
        T.pausedAt = next; T.paused = true;
        redraw(); updateTimecode();
    }
}

function tlSeekBy(direction){
    var total = totalDurationWithXfade();
    if(total <= 0) return;
    var cur = tlCurrentPos();
    var step;
    if(tl.playing){ step = shiftHeld ? 0.1 : 5.0; }
    else { step = shiftHeld ? 0.01 : 0.1; }
    var next = Math.max(0, Math.min(total, cur + direction*step));
    if(tl.playing){ tlPlay(next); }
    else {
        tl.paused = true;
        tl.pausePos = next;
        updatePlayhead(next);
        updateTlBtns();
    }
}

/* ===== Плеер МАСТЕРА ===== */
function initTimelinePlayer(){
    $('tlPlay').addEventListener('click', function(){
        setActiveContext('timeline');
        if(tl.playing) tlPause();
        else if(tl.paused) tlResume();
        else tlPlay();
    });
    $('tlStop').addEventListener('click', function(){
        setActiveContext('timeline');
        tlStop(true);
    });
    $('tlLoop').addEventListener('change', function(){
        tl.loop = $('tlLoop').checked;
        setStatus('ЦИКЛ ' + (tl.loop ? 'включён' : 'выключен'));
    });

    initTimelinePlayheadInteraction();
}

function updateTlBtns(){
    var p = $('tlPlay'), st = $('tlStop');

    if(fragments.length === 0){
        p.textContent = '▶ Воспроизвести'; p.disabled = true;
        st.textContent = '⏹ Стоп';         st.disabled = true;
        return;
    }

    if(tl.playing){ p.textContent = '❚❚ Пауза'; p.disabled = false; st.disabled = false; }
    else if(tl.paused){ p.textContent = '▶ Продолжить'; p.disabled = false; st.disabled = false; }
    else { p.textContent = '▶ Воспроизвести'; p.disabled = false; st.disabled = true; }
}

function tlStopAllSources(){
    for(var i=0;i<tl.sources.length;i++){
        try{ tl.sources[i].src.onended = null; tl.sources[i].src.stop(); }catch(e){}
        try{ tl.sources[i].src.disconnect(); }catch(e){}
        try{ tl.sources[i].gain.disconnect(); }catch(e){}
    }
    tl.sources = [];
}

function updateLiveFragGains(fragId, newFv){
    if(!tl.playing) return;
    if(fragments.length === 0) return;

    var idx = -1;
    for(var i=0;i<fragments.length;i++){
        if(fragments[i].id === fragId){ idx = i; break; }
    }
    if(idx === -1) return;

    var tlPositions = computeTimelinePositions();
    var xInfo = tlPositions[idx];
    if(!xInfo) return;

    var d = fragDuration(fragments[idx]);
    var xIn  = (idx > 0) ? (xInfo.xIn || 0) : 0;
    var xOut = (idx < fragments.length-1) ? (xInfo.xOut || 0) : 0;

    var posGlobal = tlCurrentPos();
    var localOffset = posGlobal - xInfo.fragGlobalStart;
    if(localOffset < 0 || localOffset > d) return;

    for(var s=0; s<tl.sources.length; s++){
        var entry = tl.sources[s];
        if(entry.fragId !== fragId) continue;
        var gParam = entry.gain.gain;
        var now = ctx.currentTime;

        try{ gParam.cancelScheduledValues(now); }catch(e){}

        var initGain = 1.0;
        var remaining = d - localOffset;

        var fadeInEndsInFrag = xIn;
        if(xIn > 0.0001 && localOffset < fadeInEndsInFrag){
            var gIn = localOffset / fadeInEndsInFrag;
            if(gIn < initGain) initGain = gIn;
        }
        var fadeOutStartsInFrag = d - xOut;
        if(xOut > 0.0001 && localOffset > fadeOutStartsInFrag){
            var tRem = d - localOffset;
            var gOut = tRem / xOut;
            if(gOut < initGain) initGain = gOut;
        }
        if(xIn <= 0.0001 && idx === 0 && EDGE_FADE.enabled && EDGE_FADE.inMs > 0){
            var edgeIn = EDGE_FADE.inMs/1000;
            if(localOffset < edgeIn){
                var gEdgeIn = localOffset / edgeIn;
                if(gEdgeIn < initGain) initGain = gEdgeIn;
            }
        }
        if(xOut <= 0.0001 && idx === fragments.length-1 && EDGE_FADE.enabled && EDGE_FADE.outMs > 0){
            var edgeOut = EDGE_FADE.outMs/1000;
            if(localOffset > d - edgeOut){
                var gEdgeOut = (d - localOffset) / edgeOut;
                if(gEdgeOut < initGain) initGain = gEdgeOut;
            }
        }
        if(initGain < 0.0001) initGain = 0.0001;

        gParam.setValueAtTime(initGain * newFv, now);

        var t = now;
        if(xIn > 0.0001 && localOffset < xIn){
            t += (xIn - localOffset);
            gParam.linearRampToValueAtTime(newFv, t);
        } else if(localOffset < xIn){
            gParam.linearRampToValueAtTime(newFv, now + (xIn - localOffset));
        }

        var fadeOutStarts = d - xOut;
        if(xOut > 0.0001 && fadeOutStarts > localOffset){
            var tStart = now + (fadeOutStarts - localOffset);
            var tEnd   = now + (d - localOffset);
            gParam.setValueAtTime(newFv, tStart);
            gParam.linearRampToValueAtTime(0.0001, tEnd);
        }

        if(idx === 0 && EDGE_FADE.enabled && EDGE_FADE.inMs > 0 && xIn <= 0.0001){
            var edgeIn2 = EDGE_FADE.inMs/1000;
            if(localOffset < edgeIn2){
                gParam.linearRampToValueAtTime(newFv, now + (edgeIn2 - localOffset));
            }
        }
        if(idx === fragments.length-1 && EDGE_FADE.enabled && EDGE_FADE.outMs > 0 && xOut <= 0.0001){
            var edgeOut2 = EDGE_FADE.outMs/1000;
            var startEdgeOut = d - edgeOut2;
            if(startEdgeOut > localOffset){
                gParam.setValueAtTime(newFv, now + (startEdgeOut - localOffset));
                gParam.linearRampToValueAtTime(0.0001, now + (d - localOffset));
            }
        }
    }
}

function tlPlay(fromPos){
    if(fragments.length === 0) return;

    tlCancelLoop();

    if(T.playing) pause();

    var missing = 0;
    for(var mm=0; mm<fragments.length; mm++){ if(!getBufferForFrag(fragments[mm])) missing++; }
    if(missing > 0) setStatus('Не все фрагменты привязаны к источнику (' + missing + '). Загрузите исходные файлы.', true);

    tlStopAllSources();
    var tlPositions = computeTimelinePositions();
    var total = totalDurationWithXfade();
    var startPos = (typeof fromPos === 'number') ? fromPos : 0;
    if(startPos >= total) startPos = 0;

    if(startPos === 0 && fragments.length > 0){
        var idxUnder = -1;
        for(var q=0;q<tlPositions.length;q++){
            if(tlPositions[q].fragGlobalStart <= 0 && tlPositions[q].fragGlobalEnd > 0){
                idxUnder = q;
                break;
            }
        }
        if(idxUnder !== -1){
            var fAuto = fragments[idxUnder];
            setSelectedFragIds([fAuto.id]);
            selectionAnchor = fAuto.id;
            refreshSelectionUI();
        }
    }

    tl.token = (tl.token||0)+1;
    var myToken = tl.token;

    ensureCtx(function(){
        if(myToken !== tl.token) return;
        var now = ctx.currentTime;
        tl.startT = now;
        tl.startPos = startPos;
        tl.playing = true;
        tl.paused = false;
        tl.pausePos = startPos;

        for(var i=0;i<fragments.length;i++){
            var f = fragments[i];
            var buf = getBufferForFrag(f);
            if(!buf) continue;
            var d = fragDuration(f);
            var xInfo = tlPositions[i];
            var fragGlobalStart = xInfo.fragGlobalStart;
            var fragGlobalEnd = xInfo.fragGlobalEnd;
            if(fragGlobalEnd <= startPos) continue;

            var localOffset = 0;
            if(startPos > fragGlobalStart) localOffset = startPos - fragGlobalStart;
            var when = now + Math.max(0, fragGlobalStart - startPos);
            var playDur = d - localOffset;
            if(playDur <= 0) continue;

            var src = ctx.createBufferSource();
            src.buffer = buf;
            var g = ctx.createGain();
            var fv = (typeof f.volume === 'number') ? f.volume : FRAG_VOL_DEFAULT;
            var xIn = (i > 0) ? (xInfo.xIn || 0) : 0;
            var xOut = (i < fragments.length-1) ? (xInfo.xOut || 0) : 0;
            var gParam = g.gain;

            var initGain = 1.0;
            if(xIn > 0.0001 && localOffset < xIn){
                var gIn = localOffset / xIn;
                if(gIn < initGain) initGain = gIn;
            }
            if(xOut > 0.0001){
                var tRemain = d - localOffset;
                if(tRemain < xOut){
                    if(tRemain < 0) tRemain = 0;
                    var gOut = tRemain / xOut;
                    if(gOut < initGain) initGain = gOut;
                }
            }
            if(initGain < 0.0001) initGain = 0.0001;
            gParam.cancelScheduledValues(0);
            gParam.setValueAtTime(initGain * fv, when);

            if(xIn > 0.0001){
                var fadeInEndInFrag = xIn;
                if(fadeInEndInFrag > localOffset){
                    gParam.linearRampToValueAtTime(fv, when + (fadeInEndInFrag - localOffset));
                } else {
                    gParam.setValueAtTime(fv, when);
                }
            } else if(i === 0 && EDGE_FADE.enabled && EDGE_FADE.inMs > 0){
                var edgeIn = EDGE_FADE.inMs/1000;
                if(localOffset < edgeIn){
                    gParam.setValueAtTime(Math.max(0.0001, (localOffset/edgeIn)*fv), when);
                    gParam.linearRampToValueAtTime(fv, when + (edgeIn - localOffset));
                } else {
                    gParam.setValueAtTime(fv, when);
                }
            } else {
                gParam.setValueAtTime(fv, when);
            }
            if(xOut > 0.0001){
                var fadeOutStartInFrag = d - xOut;
                if(fadeOutStartInFrag < localOffset) fadeOutStartInFrag = localOffset;
                var tStart = when + (fadeOutStartInFrag - localOffset);
                var tEnd = when + playDur;
                if(tEnd > tStart){
                    gParam.setValueAtTime(fv, tStart);
                    gParam.linearRampToValueAtTime(0.0001, tEnd);
                }
            } else if(i === fragments.length-1 && EDGE_FADE.enabled && EDGE_FADE.outMs > 0){
                var edgeOut = EDGE_FADE.outMs/1000;
                var edgeOutStartInFrag = d - edgeOut;
                if(edgeOutStartInFrag < localOffset) edgeOutStartInFrag = localOffset;
                var tStart2 = when + (edgeOutStartInFrag - localOffset);
                var tEnd2 = when + playDur;
                if(tEnd2 > tStart2){
                    gParam.setValueAtTime(fv, tStart2);
                    gParam.linearRampToValueAtTime(0.0001, tEnd2);
                }
            }
            src.connect(g); g.connect(ctx.destination);
            src.start(when, f.trimStart + localOffset, playDur);
            tl.sources.push({src:src, gain:g, fragId:f.id});
        }

        setActiveContext('timeline');
        updateTlBtns();
        tlLoop();
    });
}

function tlPause(){
    if(!tl.playing) return;
    tlCancelLoop();
    var cur = tlCurrentPos();
    tl.token = (tl.token||0)+1;
    tlStopAllSources();
    tl.playing = false;
    tl.paused = true;
    tl.pausePos = Math.max(0, Math.min(totalDurationWithXfade(), cur));
    updateTlBtns();
    updatePlayhead(tl.pausePos);
}
function tlResume(){
    if(!tl.paused) return;
    tl.paused = false;
    tlPlay(tl.pausePos);
}
function tlStop(reset){
    tlCancelLoop();
    tl.token = (tl.token||0)+1;

    if(fragments.length === 0){
        tlStopAllSources();
        tl.playing = false;
        tl.paused = false;
        tl.pausePos = 0;
        tl.startPos = 0;
        var ph = $('tlPlayhead'); if(ph) ph.style.display = 'none';
        updateTlBtns();
        return;
    }
    var cur = tl.playing ? (tl.startPos + (ctx.currentTime - tl.startT)) : (tl.pausePos || 0);
    tlStopAllSources();
    tl.playing = false;
    if(reset){
        tl.paused = false;
        tl.pausePos = 0;
        updatePlayhead(0);
    } else {
        tl.paused = true;
        tl.pausePos = Math.max(0, Math.min(cur, totalDurationWithXfade()));
        updatePlayhead(tl.pausePos);
    }
    updateTlBtns();
}
function tlCurrentPos(){
    if(tl.playing) return tl.startPos + (ctx.currentTime - tl.startT);
    return tl.pausePos || 0;
}
function updatePlayhead(pos){
    var total = totalDurationWithXfade();
    var track = $('tlTrack');
    var w = track.clientWidth || 1;
    var ph = $('tlPlayhead');
    if(total <= 0 || pos > total){ ph.style.display = 'none'; updateCutButton(); updateTimelineCounters(); return; }
    ph.style.display = 'block';
    ph.style.left = ((pos / total) * w) + 'px';
    $('tlPosCur').textContent = fmtTime(pos);
    updateCutButton();
    updateTimelineCounters();
}

function updateTimelineCounters(){
    var inEl  = $('tlInVal');
    var outEl = $('tlOutVal');
    var lenEl = $('tlFragLenVal');
    var totEl = $('tlTotalLenVal');
    if(!inEl || !outEl || !lenEl || !totEl) return;

    totEl.textContent = fmtTime(totalDurationWithXfade());

    var idxs = getSortedSelectedIndexes();
    if(idxs.length === 0){
        inEl.textContent  = '— : — . —';
        outEl.textContent = '— : — . —';
        lenEl.textContent = '— : — . —';
        return;
    }

    var tlPositions = computeTimelinePositions();

    if(idxs.length === 1){
        var i = idxs[0];
        var xInfo = tlPositions[i];
        if(!xInfo){
            inEl.textContent  = '— : — . —';
            outEl.textContent = '— : — . —';
            lenEl.textContent = fmtTime(fragDuration(fragments[i]));
            return;
        }
        inEl.textContent  = fmtTime(xInfo.fragGlobalStart);
        outEl.textContent = fmtTime(xInfo.fragGlobalEnd);
        lenEl.textContent = fmtTime(fragDuration(fragments[i]));
        return;
    }

    var minStart = Infinity;
    var maxEnd   = -Infinity;
    var sum = 0;
    for(var k=0;k<idxs.length;k++){
        var xi = tlPositions[idxs[k]];
        if(!xi) continue;
        if(xi.fragGlobalStart < minStart) minStart = xi.fragGlobalStart;
        if(xi.fragGlobalEnd   > maxEnd)   maxEnd   = xi.fragGlobalEnd;
        sum += fragDuration(fragments[idxs[k]]);
    }
    if(minStart === Infinity || maxEnd === -Infinity){
        inEl.textContent  = '— : — . —';
        outEl.textContent = '— : — . —';
    } else {
        inEl.textContent  = fmtTime(minStart);
        outEl.textContent = fmtTime(maxEnd);
    }
    lenEl.textContent = fmtTime(sum);
}
function tlCancelLoop(){
    if(tl.raf){ cancelAnimationFrame(tl.raf); tl.raf = null; }
}
function tlLoop(){
    var tick = function(){
        if(!tl.playing){ tl.raf = null; return; }
        var pos = tlCurrentPos();
        var total = totalDurationWithXfade();
        if(pos >= total){
            if(tl.loop){
                tlStopAllSources();
                tl.playing = false;
                tl.paused = false;
                tlPlay(0);
                return;
            }
            tl.playing = false;
            tl.paused = false;
            tl.pausePos = 0;
            tlStopAllSources();
            updateTlBtns();
            updatePlayhead(0);
            tl.raf = null;
            return;
        }
        updatePlayhead(pos);
        tl.raf = requestAnimationFrame(tick);
    };
    tl.raf = requestAnimationFrame(tick);
}

/* ===== Плейхед МАСТЕРА ===== */
function getTrackGeom(){
    var track = $('tlTrack');
    var total = totalDurationWithXfade();
    if(!track || total <= 0) return null;
    var w = track.clientWidth;
    var h = track.clientHeight;
    if(w <= 0 || h <= 0) return null;
    return { w:w, h:h, total:total, topY: 0, botY: h };
}

function tlTimeToX(sec, geom){
    if(!geom) return 0;
    return (sec / geom.total) * geom.w;
}

function hitTestTlPlayhead(x, y){
    var geom = getTrackGeom();
    if(!geom) return null;
    var hitR = MARK_RADIUS + MARK_HIT_PAD;

    var total = totalDurationWithXfade();
    var pos = tlCurrentPos();
    if(pos < 0 || pos > total) return null;
    var xPl = tlTimeToX(pos, geom);

    function near(x1, y1, x2, y2){
        var dx = x1 - x2, dy = y1 - y2;
        return (dx*dx + dy*dy) <= (hitR * hitR);
    }

    if(Math.abs(x - xPl) <= 10 && y <= 14) return 'play';
    if(near(x, y, xPl, geom.h - MARK_RADIUS - 2)) return 'play';

    return null;
}

function initTimelinePlayheadInteraction(){
    var track = $('tlTrack');
    if(!track) return;

    var CLICK_SLOP = 5;

    track.addEventListener('mousedown', function(e){
        if(fragments.length === 0) return;
        if(e.button !== 0) return;

        var tgt = e.target;
        if(tgt.classList.contains('frag-handle')) return;
        if(tgt.classList.contains('frag-volume-line')) return;
        if(tgt.classList.contains('frag-xfade')) return;

        setActiveContext('timeline');

        var r = track.getBoundingClientRect();
        var x = e.clientX - r.left;
        var y = e.clientY - r.top;

        if(hitTestTlPlayhead(x, y) === 'play'){
            tl.dragMode = 'play';
            tl.dragStartX = e.clientX;
            tl.dragStartVal = tlCurrentPos();
            e.preventDefault();
            e.stopPropagation();
            return;
        }

        var startX = e.clientX;
        var startY = e.clientY;
        var moved = false;

        function onMoveDoc(ev){
            var dx = ev.clientX - startX;
            var dy = ev.clientY - startY;
            if(dx*dx + dy*dy > CLICK_SLOP*CLICK_SLOP){
                moved = true;
                cleanup();
            }
        }
        function onUpDoc(ev){
            cleanup();
            if(moved) return;
            var rr = track.getBoundingClientRect();
            var xx = ev.clientX - rr.left;
            var total = totalDurationWithXfade();
            var t = (xx / rr.width) * total;
            if(t < 0) t = 0;
            if(t > total) t = total;

            if(tl.playing){
                tl.playing = false;
                tl.paused = true;
                tl.pausePos = t;
                tlPlay(t);
            } else {
                tl.paused = true;
                tl.pausePos = t;
                updatePlayhead(t);
                updateTlBtns();
            }
        }
        function cleanup(){
            document.removeEventListener('mousemove', onMoveDoc);
            document.removeEventListener('mouseup', onUpDoc);
        }
        document.addEventListener('mousemove', onMoveDoc);
        document.addEventListener('mouseup', onUpDoc);
    });

    track.addEventListener('mousemove', function(e){
        if(fragments.length === 0) return;
        var r = track.getBoundingClientRect();
        var x = e.clientX - r.left;
        var y = e.clientY - r.top;

        if(tl.dragMode === 'play'){
            var total = totalDurationWithXfade();
            var dx = e.clientX - tl.dragStartX;
            var dSec = (dx / r.width) * total;
            var newVal = tl.dragStartVal + dSec;
            if(newVal < 0) newVal = 0;
            if(newVal > total) newVal = total;
            tl.pausePos = newVal;
            tl.paused = true;
            if(tl.playing){
                tlStopAllSources();
                tl.playing = false;
                tl.paused = true;
                updateTlBtns();
            }
            updatePlayhead(newVal);
            return;
        }

        var tgt = e.target;
        var overHandle = tgt.classList.contains('frag-handle') ||
                         tgt.classList.contains('frag-volume-line') ||
                         tgt.classList.contains('frag-xfade');
        if(overHandle){ track.style.cursor = ''; return; }

        var hit = hitTestTlPlayhead(x, y);
        track.style.cursor = (hit === 'play') ? 'ew-resize' : '';
    });

    document.addEventListener('mouseup', function(){
        if(tl.dragMode){
            tl.dragMode = null;
            updatePlayhead(tlCurrentPos());
        }
    });

    track.addEventListener('mouseleave', function(){
        if(!tl.dragMode) track.style.cursor = '';
    });
}

/* ===== Сборка микса ===== */
function buildMixBuffer(applyEdgeFade, applyNormalize){
    if(fragments.length === 0) return null;

    var hz = null;
    var maxCh = 1;
    for(var i=0;i<fragments.length;i++){
        var b = getBufferForFrag(fragments[i]);
        if(b){
            if(hz === null) hz = b.sampleRate;
            if(b.numberOfChannels > maxCh) maxCh = b.numberOfChannels;
        }
    }
    if(hz === null) return null;
    maxCh = Math.min(2, maxCh);

    var tlPositions = computeTimelinePositions();
    var total = totalDurationWithXfade();
    if(total <= 0) return null;
    var totalSamples = Math.ceil(total * hz);
    if(totalSamples <= 0) return null;

    var out = ctx.createBuffer(maxCh, totalSamples, hz);
    var edgeFades = getEdgeFadeDurations();

    for(var i=0;i<fragments.length;i++){
        var f = fragments[i];
        var buf = getBufferForFrag(f);
        if(!buf) continue;
        var d = fragDuration(f);
        var xInfo = tlPositions[i];
        var fragGlobalStart = xInfo.fragGlobalStart;
        var xIn = (i > 0) ? xInfo.xIn : 0;
        var xOut = (i < fragments.length-1) ? xInfo.xOut : 0;

        var startS = Math.max(0, Math.floor(f.trimStart * hz));
        var endS   = Math.min(buf.length, Math.floor(f.trimEnd * hz));
        var len = endS - startS;
        if(len <= 0) continue;

        var chs = buf.numberOfChannels;
        var fv = (typeof f.volume === 'number') ? f.volume : FRAG_VOL_DEFAULT;
        var writeOffsetSamples = Math.round(fragGlobalStart * hz);
        var fadeInSamples = Math.round(xIn * hz);
        var fadeOutSamples = Math.round(xOut * hz);

        var edgeInSamples = 0, edgeOutSamples = 0;
        if(applyEdgeFade){
            if(i === 0) edgeInSamples = Math.round(edgeFades.fi * hz);
            if(i === fragments.length-1) edgeOutSamples = Math.round(edgeFades.fo * hz);
        }
        if(xIn > 0.001) edgeInSamples = 0;
        if(xOut > 0.001) edgeOutSamples = 0;

        var env = new Float32Array(len);
        for(var j=0;j<len;j++){
            var e = 1.0;
            if(edgeInSamples > 0 && j < edgeInSamples) e *= (j / edgeInSamples);
            if(edgeOutSamples > 0 && j >= len - edgeOutSamples){
                var kk = (len - 1 - j) / edgeOutSamples;
                if(kk < 0) kk = 0;
                e *= kk;
            }
            if(fadeInSamples > 0 && j < fadeInSamples) e *= (j / fadeInSamples);
            if(fadeOutSamples > 0 && j >= len - fadeOutSamples){
                var k2 = (len - 1 - j) / fadeOutSamples;
                if(k2 < 0) k2 = 0;
                e *= k2;
            }
            env[j] = e * fv;
        }

        for(var ch=0; ch<maxCh; ch++){
            var srcData = buf.getChannelData(ch < chs ? ch : 0);
            var dstData = out.getChannelData(ch);
            for(var j=0;j<len;j++){
                var dstIdx = writeOffsetSamples + j;
                if(dstIdx >= 0 && dstIdx < dstData.length){
                    dstData[dstIdx] += (srcData[startS + j] || 0) * env[j];
                }
            }
        }
    }

    if(applyNormalize) normalizeBuffer(out);
    return out;
}

function normalizeBuffer(buf){
    var chs = buf.numberOfChannels;
    var peak = 0;
    var chans = [];
    for(var ch=0; ch<chs; ch++){
        var d = buf.getChannelData(ch);
        chans.push(d);
        for(var i=0;i<d.length;i++){
            var v = d[i] < 0 ? -d[i] : d[i];
            if(v > peak) peak = v;
        }
    }
    if(peak <= 0.0001) return;
    var targetPeak = 0.9661;
    var gain = targetPeak / peak;
    if(gain === 1) return;
    for(var ch=0; ch<chans.length; ch++){
        var d = chans[ch];
        for(var i=0;i<d.length;i++){
            var v = d[i] * gain;
            if(v > 1) v = 1; else if(v < -1) v = -1;
            d[i] = v;
        }
    }
}

/* ===== Экспорт ===== */
function initExportMenu(){
    var btn = $('btnExport');
    var menu = $('exportMenu');
    var mp3Bits = $('mp3Bits');
    var mp3Top = $('btnMp3Top');

    btn.addEventListener('click', function(e){
        e.stopPropagation();
        if(btn.disabled) return;
        menu.classList.toggle('open');
        if(!menu.classList.contains('open')) mp3Bits.classList.remove('open');
    });
    document.addEventListener('click', function(e){
        if(!menu.contains(e.target) && e.target !== btn){
            menu.classList.remove('open');
            mp3Bits.classList.remove('open');
            var ob2 = $('opusBits');
            if(ob2) ob2.classList.remove('open');
        }
    });
    menu.querySelector('[data-format="wav"]').addEventListener('click', function(){
        menu.classList.remove('open');
        mp3Bits.classList.remove('open');
        var ob3 = $('opusBits');
        if(ob3) ob3.classList.remove('open');
        startExport('wav');
    });
    mp3Top.addEventListener('click', function(e){
        e.stopPropagation();
        mp3Bits.classList.toggle('open');
    });

    var bitBtns = menu.querySelectorAll('.bit-btn[data-bit]');
    for(var i=0;i<bitBtns.length;i++){
        (function(b){
            b.addEventListener('click', function(){
                for(var k=0;k<bitBtns.length;k++) bitBtns[k].classList.remove('active');
                b.classList.add('active');
            });
        })(bitBtns[i]);
    }
    $('btnMp3Go').addEventListener('click', function(){
        var active = menu.querySelector('.bit-btn.active');
        var bit = active ? parseInt(active.dataset.bit, 10) : 192;
        menu.classList.remove('open');
        mp3Bits.classList.remove('open');
        startExport('mp3', bit);
    });

    var opusBits = $('opusBits');
    var opusTop  = $('btnOpusTop');
    if(opusTop && opusBits){
        opusTop.addEventListener('click', function(e){
            e.stopPropagation();
            mp3Bits.classList.remove('open');
            opusBits.classList.toggle('open');
        });
        var opusBitBtns = opusBits.querySelectorAll('.bit-btn[data-opus-bit]');
        for(var ob=0;ob<opusBitBtns.length;ob++){
            (function(b){
                b.addEventListener('click', function(){
                    for(var k=0;k<opusBitBtns.length;k++) opusBitBtns[k].classList.remove('active');
                    b.classList.add('active');
                });
            })(opusBitBtns[ob]);
        }
        $('btnOpusGo').addEventListener('click', function(){
            var activeOpus = opusBits.querySelector('.bit-btn.active');
            var opusBit = activeOpus ? parseInt(activeOpus.dataset.opusBit, 10) : 96;
            menu.classList.remove('open');
            opusBits.classList.remove('open');
            startExport('opus', opusBit);
        });
    }
    $('optNormalize').addEventListener('change', function(){
        $('normInfo').textContent = this.checked ? 'peak → -0.3dB' : 'выкл';
    });
    $('optApplyFade').addEventListener('change', function(){
        $('fadeExpInfo').textContent = this.checked
            ? (EDGE_FADE.inMs + '/' + EDGE_FADE.outMs + ' мс')
            : 'выкл';
    });

    var normCb = $('optNormalize');
    if(normCb) $('normInfo').textContent = normCb.checked ? 'peak → -0.3dB' : 'выкл';
    var fadeCb = $('optApplyFade');
    if(fadeCb) $('fadeExpInfo').textContent = fadeCb.checked
        ? (EDGE_FADE.inMs + '/' + EDGE_FADE.outMs + ' мс')
        : 'выкл';
}

function triggerDownload(blob, filename){
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function(){ URL.revokeObjectURL(url); }, 2000);
}

var exporting = false;
function setExportBusy(busy){
    var be = $('btnExport');
    if(be) be.disabled = busy ? true : (fragments.length === 0);
    var bm = $('btnMp3Go');
    if(bm) bm.disabled = busy;
}
function startExport(format, bitrate){
    if(fragments.length === 0){ setStatus('Нет фрагментов для экспорта', true); return; }
    if(exporting) return;
    exporting = true;
    setExportBusy(true);

    var applyEdge = $('optApplyFade').checked;
    var applyNorm = $('optNormalize').checked;
    setStatus('Собираем микс…');

    setTimeout(function(){
        var asyncExport = false;
        try{
            var mixBuf = buildMixBuffer(applyEdge, applyNorm);
            if(!mixBuf){
                setStatus('Не удалось собрать микс (нет данных источника)', true);
            } else {
                var totalSec = mixBuf.duration;
                if(format === 'wav'){
                    var wavAb = exportWav(mixBuf);
                    var blob = new Blob([wavAb], {type:'audio/wav'});
                    triggerDownload(blob, 'mixdown.wav');
                    setStatus('Готово! WAV сохранён (' + fmtTime(totalSec) + ').');
                } else if(format === 'mp3'){
                    setStatus('Кодируем MP3 (' + bitrate + ' kbps)…');
                    var mp3Blob = encodeMp3Lame(mixBuf, bitrate);
                    triggerDownload(mp3Blob, 'mixdown_' + bitrate + '.mp3');
                    setStatus('Готово! MP3 сохранён (' + fmtTime(totalSec) + ', ' + bitrate + ' kbps).');
                } else if(format === 'opus'){
                    asyncExport = true;
                    encodeOpusAsync(mixBuf, bitrate, function(ok, blob, err){
                        if(ok){
                            var t = blob.type || '';
                            var ext = (t.indexOf('ogg') !== -1) ? '.opus' : '.webm';
                            triggerDownload(blob, 'mixdown_' + bitrate + 'k' + ext);
                            setStatus('Готово! OPUS сохранён (' + fmtTime(totalSec) + ', ' + bitrate + ' kbps).');
                        } else {
                            setStatus('Ошибка Opus: ' + (err && err.message ? err.message : err), true);
                        }
                        exporting = false;
                        setExportBusy(false);
                    });
                    return;
                }
            }
        }catch(err){
            console.error('[Export]', err);
            setStatus('Ошибка экспорта: ' + err.message, true);
        }finally{
            if(!asyncExport){
                exporting = false;
                setExportBusy(false);
            }
        }
    }, 30);
}

function encodeMp3Lame(audioBuffer, kbps){
    var numCh = audioBuffer.numberOfChannels;
    var sampleRate = audioBuffer.sampleRate;
    var mp3Channels = Math.min(2, numCh);
    var encoder = new lamejs.Mp3Encoder(mp3Channels, sampleRate, kbps);
    var left = floatTo16(audioBuffer.getChannelData(0));
    var right;
    if(mp3Channels === 2) right = floatTo16(numCh > 1 ? audioBuffer.getChannelData(1) : audioBuffer.getChannelData(0));
    var sampleBlockSize = 1152;
    var mp3Data = [];
    var len = left.length;
    for(var i=0; i<len; i += sampleBlockSize){
        var leftChunk = left.subarray(i, i + sampleBlockSize);
        var rightChunk = (mp3Channels === 2) ? right.subarray(i, i + sampleBlockSize) : null;
        var mp3buf = (mp3Channels === 2)
            ? encoder.encodeBuffer(leftChunk, rightChunk)
            : encoder.encodeBuffer(leftChunk);
        if(mp3buf.length > 0) mp3Data.push(new Int8Array(mp3buf));
    }
    var end = encoder.flush();
    if(end.length > 0) mp3Data.push(new Int8Array(end));
    return new Blob(mp3Data, {type:'audio/mp3'});
}

/* ===== Opus через MediaRecorder ===== */
function pickOpusMime(){
    if(typeof MediaRecorder === 'undefined') return null;
    var candidates = [
        'audio/ogg;codecs=opus',
        'audio/webm;codecs=opus',
        'audio/webm'
    ];
    for(var i=0;i<candidates.length;i++){
        try{
            if(MediaRecorder.isTypeSupported(candidates[i])) return candidates[i];
        }catch(e){}
    }
    return null;
}

function encodeOpusAsync(audioBuffer, kbps, cb){
    var mime = pickOpusMime();
    if(!mime){
        cb(false, null, new Error('Браузер не поддерживает запись Opus (MediaRecorder).'));
        return;
    }

    var ov = $('loadOverlay');
    var wasInPlayer = ov && ov.parentNode && ov.parentNode.id === 'blockPlayer';
    if(ov && wasInPlayer){
        document.body.appendChild(ov);
        ov.classList.add('global');
    }
    if(ov) ov.classList.add('active');

    var txt = $('loadText');
    var bar = $('loadBar');
    var fill = $('loadBarFill');
    var pct = $('loadPercent');
    var total = audioBuffer.duration || 0;

    if(txt) txt.textContent = 'Кодирую Opus (' + kbps + ' kbps)…';
    if(bar){ bar.classList.add('active'); bar.classList.remove('indeterminate'); }
    if(fill) fill.style.width = '0%';
    if(pct) pct.textContent = '0%';

    var chunks = [];
    var recorder = null;
    var srcNode = null;
    var streamDest = null;
    var startTime = 0;
    var rafId = null;
    var finished = false;

    function cleanup(){
        if(rafId){ cancelAnimationFrame(rafId); rafId = null; }
        if(srcNode){ try{ srcNode.onended = null; srcNode.stop(); }catch(e){} try{ srcNode.disconnect(); }catch(e){} srcNode = null; }
        if(streamDest){ try{ streamDest.disconnect(); }catch(e){} streamDest = null; }
        if(recorder){ try{ recorder.onstop = null; recorder.ondataavailable = null; recorder.onerror = null; }catch(e){} recorder = null; }
        if(ov){
            ov.classList.remove('active');
            ov.classList.remove('global');
            var pb = $('blockPlayer');
            if(pb && ov.parentNode !== pb){
                pb.appendChild(ov);
            }
        }
        if(txt) txt.textContent = 'Читаю файл…';
        if(bar) bar.classList.remove('active','indeterminate');
        if(fill) fill.style.width = '0%';
        if(pct) pct.textContent = '';
    }

    function finish(ok, err){
        if(finished) return;
        finished = true;
        cleanup();
        if(!ok){ cb(false, null, err); return; }
        try{
            var blob = new Blob(chunks, { type: mime.split(';')[0] });
            if(blob.size === 0){ cb(false, null, new Error('MediaRecorder вернул пустой файл')); return; }
            cb(true, blob, null);
        }catch(e){
            cb(false, null, e);
        }
    }

    try{
        streamDest = ctx.createMediaStreamDestination();
        srcNode = ctx.createBufferSource();
        srcNode.buffer = audioBuffer;
        srcNode.connect(streamDest);

        var opts = { mimeType: mime };
        if(typeof kbps === 'number' && kbps > 0){
            opts.audioBitsPerSecond = kbps * 1000;
        }

        recorder = new MediaRecorder(streamDest.stream, opts);

        recorder.ondataavailable = function(e){
            if(e.data && e.data.size > 0) chunks.push(e.data);
        };
        recorder.onerror = function(e){
            finish(false, e.error || new Error('MediaRecorder error'));
        };
        recorder.onstop = function(){
            finish(true, null);
        };

        recorder.start(1000);

        startTime = ctx.currentTime;
        srcNode.start(0);

        function tickProgress(){
            if(finished) return;
            var elapsed = ctx.currentTime - startTime;
            var p = total > 0 ? Math.min(100, (elapsed / total) * 100) : 0;
            if(fill) fill.style.width = p + '%';
            if(pct) pct.textContent = Math.round(p) + '%';
            if(elapsed >= total + 0.15){
                try{ recorder.stop(); }catch(e){ finish(false, e); }
                return;
            }
            rafId = requestAnimationFrame(tickProgress);
        }

        srcNode.onended = function(){
            setTimeout(function(){
                if(finished) return;
                try{ recorder.stop(); }catch(e){ finish(false, e); }
            }, 120);
        };

        tickProgress();

    }catch(err){
        finish(false, err);
    }
}

function floatTo16(float32){
    var out = new Int16Array(float32.length);
    for(var i=0;i<float32.length;i++){
        var s = Math.max(-1, Math.min(1, float32[i]));
        out[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return out;
}

function exportWav(buf){
    var chs=buf.numberOfChannels, bytes=buf.length*chs*2+44;
    var ab=new ArrayBuffer(bytes), v=new DataView(ab), hz=buf.sampleRate;
    v.setUint32(0,0x52494646,false); v.setUint32(4,bytes-8,true); v.setUint32(8,0x57415645,false);
    v.setUint32(12,0x666d7420,false); v.setUint32(16,16,true); v.setUint16(20,1,true);
    v.setUint16(22,chs,true); v.setUint32(24,hz,true); v.setUint32(28,hz*chs*2,true);
    v.setUint16(32,chs*2,true); v.setUint16(34,16,true);
    v.setUint32(36,0x64617461,false); v.setUint32(40,bytes-44,true);
    var pos=44, off=0;
    while(pos<bytes){
        for(var ch=0;ch<chs;ch++){
            var s=Math.max(-1,Math.min(1,buf.getChannelData(ch)[off]));
            s=s<0?s*0x8000:s*0x7FFF;
            v.setInt16(pos,s,true); pos+=2;
        }
        off++;
    }
    return ab;
}

/* ===== Настройки микширования ===== */
function initXfadeControls(){
    $('xfEnable').addEventListener('change', function(){
        var editPos = pauseTlForEdit();
        pushHistory();
        XFADE.enabled = this.checked;

        normalizeXfadesAtSeams();

        renderTimeline();
        setStatus('Микс ' + (XFADE.enabled ? 'включён' : 'выключен'));
        if(editPos !== null) resumeTlAfterEdit(editPos);
    });
}

/* ===== Фокус по клику на блок ===== */
function initBlockFocus(){
    var pb = $('blockPlayer');
    var tb = $('blockTimeline');
    if(pb){
        pb.addEventListener('mousedown', function(){
            if(isHelpOpen()) return;
            setActiveContext('player');
        }, true);
    }
    if(tb){
        tb.addEventListener('mousedown', function(){
            if(isHelpOpen()) return;
            setActiveContext('timeline');
        }, true);
    }
}

/* ===== Справка ===== */
function openHelpModal(){
    var m = $('helpModal');
    if(!m) return;
    m.classList.add('open');
    m.setAttribute('aria-hidden', 'false');
    var btn = $('helpClose');
    if(btn) btn.focus();
}
function closeHelpModal(){
    var m = $('helpModal');
    if(!m) return;
    m.classList.remove('open');
    m.setAttribute('aria-hidden', 'true');
}
function isHelpOpen(){
    var m = $('helpModal');
    return !!(m && m.classList.contains('open'));
}

function initHelpModal(){
    var gear = $('helpGear');
    var closeBtn = $('helpClose');
    var modal = $('helpModal');
    if(!gear || !modal) return;

    gear.addEventListener('click', function(e){
        e.stopPropagation();
        if(isHelpOpen()) closeHelpModal();
        else openHelpModal();
    });

    if(closeBtn){
        closeBtn.addEventListener('click', function(e){
            e.stopPropagation();
            closeHelpModal();
        });
    }

    var backdrops = modal.querySelectorAll('[data-help-close]');
    for(var i=0;i<backdrops.length;i++){
        backdrops[i].addEventListener('click', closeHelpModal);
    }

    document.addEventListener('keydown', function(e){
        if(!isHelpOpen()) return;
        if(e.key === 'Escape'){
            e.preventDefault();
            e.stopPropagation();
            closeHelpModal();
        }
    }, true);
}

/* ===== Обратная связь ===== */
var FEEDBACK_ENDPOINT = 'https://script.google.com/macros/s/AKfycbwW7CmGVqqrAJPTW3R47D-mZObwQIbJcw_kGjmaa-iDUn3Fluey2kKe-jzgxm2L5vl8/exec';

function setFeedbackStatus(text, kind){
    var el = $('feedbackStatus');
    if(!el) return;
    el.textContent = text;
    el.title = text;
    el.className = 'status-inline' + (kind ? ' ' + kind : '');
}

function initFeedbackForm(){
    var form = $('feedbackForm');
    if(!form) return;

    setFeedbackStatus('Есть идея или нашёл баг? Напиши!');

    form.addEventListener('submit', function(e){
        e.preventDefault();
        sendFeedback();
    });

    var toggle = $('feedbackToggle');
    var block  = $('blockFeedback');
    if(toggle && block){
        toggle.addEventListener('click', function(){
            block.classList.toggle('open');
            var isOpen = block.classList.contains('open');
            toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
            if(isOpen){
                setTimeout(function(){
                    var nameInput = $('fbName');
                    if(nameInput && !nameInput.value) nameInput.focus();
                }, 350);
            }
        });

        toggle.addEventListener('keydown', function(e){
            if(e.key === 'Enter' || e.key === ' '){
                e.preventDefault();
                toggle.click();
            }
        });
    }
}

function sendFeedback(){
    var nameEl = $('fbName');
    var msgEl  = $('fbMessage');
    var btn    = $('fbSubmit');
    if(!nameEl || !msgEl || !btn) return;

    var name    = (nameEl.value || '').trim();
    var message = (msgEl.value  || '').trim();

    if(name.length < 1){
        setFeedbackStatus('Введите имя', 'fb-err');
        nameEl.focus();
        return;
    }
    if(message.length < 3){
        setFeedbackStatus('Сообщение слишком короткое', 'fb-err');
        msgEl.focus();
        return;
    }

    btn.disabled = true;
    nameEl.disabled = true;
    msgEl.disabled  = true;
    var btnOrigText = btn.textContent;
    btn.textContent = '⏳ Отправляю…';
    setFeedbackStatus('Отправляю…', 'fb-sending');

    var body = 'name='    + encodeURIComponent(name) +
               '&message=' + encodeURIComponent(message);

    fetch(FEEDBACK_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: body
    })
    .then(function(resp){
        if(!resp.ok) throw new Error('HTTP ' + resp.status);
        return resp.text().then(function(txt){
            try{ return JSON.parse(txt); }
            catch(e){ return { result: 'unknown', raw: txt }; }
        });
    })
    .then(function(data){
        if(data && data.result === 'success'){
            setFeedbackStatus('✅ Спасибо! Сообщение отправлено.', 'fb-ok');
            nameEl.value = '';
            msgEl.value  = '';
        } else {
            throw new Error('Неожиданный ответ: ' + JSON.stringify(data));
        }
    })
    .catch(function(err){
        console.error('[Feedback]', err);
        setFeedbackStatus('❌ Не удалось отправить. Попробуйте позже.', 'fb-err');
    })
    .then(function(){
        btn.disabled = false;
        nameEl.disabled = false;
        msgEl.disabled  = false;
        btn.textContent = btnOrigText;
    });
}

/* ===== Старт ===== */
function init(){
    initPlayer();
    initWaveInteraction();
    initTimelinePlayer();
    initExportMenu();
    initXfadeControls();
    initFileZone();
    initMarkButtons();
    initBlockFocus();

    $('btnAddFrag').addEventListener('click', addFragment);
    $('tlDelete').addEventListener('click', deleteSelectedFragments);
    $('tlCut').addEventListener('click', cutSelectedFragment);
    $('tlCopy').addEventListener('click', copySelectedFragments);
    $('tlPaste').addEventListener('click', pasteFragmentsFromClipboard);
    $('btnUndo').addEventListener('click', undo);
    $('btnRedo').addEventListener('click', redo);
    document.addEventListener('keydown', onUndoRedoKey);
    document.addEventListener('keydown', onKey);
    document.addEventListener('keydown', onTlKey);

    renderActivePanel();
    renderTimeline();
    updateActiveHighlight();
    hideLoadOverlay();

    var resizeTimer = null;
    function onViewportResize(){
        if(resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(function(){
            resizeTimer = null;
            invalidateWaveCache();
            var s = getActiveSource();
            if(s && s.buffer) redraw();
            if(fragments.length) renderTimeline();
        }, 120);
    }
    window.addEventListener('resize', onViewportResize);
    if(window.ResizeObserver){
        var ro = new ResizeObserver(onViewportResize);
        var cont = document.querySelector('.container');
        if(cont) ro.observe(cont);
    }

    initHelpModal();
    initFeedbackForm();
}

if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', init);
else init();

})();