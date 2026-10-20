// ==UserScript==
// @name         爱奇艺暂停广告自动关闭
// @namespace    local.iqiyi.pause-ad-helper
// @version      1.0
// @description  直接响应画面单击与空格的播放切换，减少广告重复关闭，保留无闪现和全屏布局适配。
// @match        *://*.iqiyi.com/*
// @run-at       document-start
// @noframes
// @sandbox      DOM
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function () {
    'use strict';

    const VERSION = '1.0';
    const BUTTON = '#outlayer .pause-max-close-area > .pause-max-close-btn';
    const MARK = 'data-iqiyi-pause-preserve';
    const GUARD = 'data-iqiyi-pause-guard';
    const MEDIA_PLAY = HTMLMediaElement.prototype.play;
    const MEDIA_PAUSE = HTMLMediaElement.prototype.pause;
    const EDITABLE = 'input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="combobox"]';
    const CONTROLS = 'a,button,input,textarea,select,label,[contenteditable]:not([contenteditable="false"]),' +
        '[role="button"],[role="slider"],[role="menuitem"],[role="checkbox"],[role="switch"],' +
        '[class*="XPlayer_bottom"],[class*="XPlayer_playerCtrl"],[class*="XPlayer_heatMap"],' +
        '[class*="XPlayer_top"],[class*="iqp-player-control"],.pause-max-close-area,.pause-main.maxPauseAd-container';
    const EARLY_CSS = `
        #outlayer .pause-main.maxPauseAd-container,
        #outlayer .pause-max-close-area,
        #outlayer > .flash-max1:has(> .pause-max-close-area):not(:has(video)) {
            clip-path: inset(100%) !important;
            pointer-events: none !important;
        }
        html[${GUARD}] [${MARK}] {
            transition: none !important;
            animation: none !important;
        }
    `;
    // 不隐藏播放器本身；clip-path 只遮蔽已知暂停广告面板的绘制。
    // 这样仍能检查网站自身的 display/visibility，点击被遮蔽的关闭按钮。
    let earlyStyle = null;
    try {
        if (typeof GM_addStyle === 'function') earlyStyle = GM_addStyle(EARLY_CSS);
    } catch (error) {
        console.debug('[爱奇艺暂停广告助手] 等待页面样式容器：', error);
    }

    // 只记录几何属性，不固定祖先的 display、visibility、opacity 或点击状态。
    const GEOMETRY = [
        'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
        'position', 'left', 'top', 'right', 'bottom', 'transform', 'transform-origin',
        'translate', 'scale', 'rotate',
        'margin-left', 'margin-top', 'margin-right', 'margin-bottom',
        'flex-basis', 'flex-grow', 'flex-shrink', 'align-self', 'zoom', 'box-sizing', 'aspect-ratio'
    ];
    // 尺寸参照容器自身保持弹性布局，只阻止广告对它施加变换。
    const BOUNDARY_GEOMETRY = ['transform', 'transform-origin', 'translate', 'scale', 'rotate', 'zoom'];
    const X_LENGTHS = new Set(['width', 'min-width', 'max-width', 'left', 'right', 'margin-left', 'margin-right']);
    const Y_LENGTHS = new Set(['height', 'min-height', 'max-height', 'top', 'bottom', 'margin-top', 'margin-bottom']);
    const lastAttempt = new WeakMap();
    let visibleButtons = new Set();
    const playedVideos = new WeakSet();
    let root;
    let layoutStyle;
    let baseline = null;
    let guarded = false;
    let busy = false;
    let frame = 0;
    let token = 0;
    let viewportEpoch = 0;
    let viewportUntil = 0;
    let resizeObserver;
    let observedBoundary;
    let observedWidth = 0;
    let observedHeight = 0;
    let attempts = 0;
    let restored = 0;
    let lastCaptureAt = -Infinity;
    let pauseArmed = false;
    let cyclePending = false;
    let naturalRestored = false;
    let pauseSession = 0;
    let retryTimer = 0;
    let resumeUntil = 0;
    let pointerStart = null;
    let spaceConsumed = false;
    let inputSerial = 0;
    let lastInput = '尚未操作';
    let lastInputError = '';

    function isShown(element) {
        if (!element.isConnected || !element.getClientRects().length) return false;
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        for (let node = element; node; node = node.parentElement) {
            const style = getComputedStyle(node);
            if (node.hidden || style.display === 'none' ||
                style.visibility === 'hidden' || style.visibility === 'collapse' ||
                Number(style.opacity) === 0) return false;
        }
        return true;
    }

    function activeButtons() {
        return [...document.querySelectorAll(BUTTON)].filter(isShown);
    }

    function chooseVideo(preferred) {
        // 用户实际页面的正片节点，优先于页面上其它视频。
        const main = document.querySelector('#outlayer video.inner-video');
        if (main && isShown(main)) return main;
        if (preferred?.tagName === 'VIDEO' && isShown(preferred)) return preferred;
        if (baseline?.video.isConnected && isShown(baseline.video)) return baseline.video;
        return [...document.querySelectorAll('video')].filter(isShown)
            .sort((a, b) => {
                const x = a.getBoundingClientRect();
                const y = b.getBoundingClientRect();
                return y.width * y.height - x.width * x.height;
            })[0];
    }

    function inputVideo() {
        const video = document.querySelector('#outlayer video.inner-video') || baseline?.video;
        // 只接管已经载入、可播放的正片；加载页、片尾页和其它视频保留网站行为。
        if (!video?.isConnected || video.readyState < 2 || video.ended || video.error || !isShown(video)) return null;
        if (!video.closest('#outlayer')) return null;
        return video;
    }

    function inputScope(video) {
        const area = video.closest('#areaContainer');
        return video.closest('#video') ||
            (area?.parentElement !== document.body ? area?.parentElement : area) ||
            video.closest('#areaLeftContainer') || video.closest('#outlayer');
    }

    function pictureTarget(event, video) {
        const target = event.target;
        const scope = inputScope(video);
        if (!(target instanceof Element) || !scope?.contains(target) || target.closest(CONTROLS)) return false;
        if (video.controls && target === video) return false;
        const rect = video.getBoundingClientRect();
        // 留出播放器顶部、底部的工具区域；进度条等已知控件另有明确排除。
        return event.clientX >= rect.left && event.clientX <= rect.right &&
            event.clientY > rect.top + Math.min(40, rect.height * 0.08) &&
            event.clientY < rect.bottom - Math.min(80, rect.height * 0.16);
    }

    function consume(event) {
        event.preventDefault();
        event.stopImmediatePropagation();
    }

    function setPlayback(video, wantPaused, source) {
        const serial = ++inputSerial;
        lastInput = `${source} → ${wantPaused ? '暂停' : '播放'}`;
        lastInputError = '';
        root.setAttribute('data-iqiyi-pause-last-input', lastInput);
        if (wantPaused) {
            resumeUntil = 0;
        } else {
            // 用户已要求继续播放，不再点击旧暂停周期中尚未移除的关闭按钮。
            resumeUntil = performance.now() + 1200;
            pauseArmed = false;
        }
        try {
            if (wantPaused) {
                if (!video.paused) MEDIA_PAUSE.call(video);
            } else if (video.paused) {
                const result = MEDIA_PLAY.call(video);
                if (result?.catch) result.catch(error => {
                    // 快速“播放→暂停”中，被后一次操作取消的旧 Promise 不算故障。
                    if (serial !== inputSerial) return;
                    lastInputError = `${error.name || 'Error'}: ${error.message || error}`;
                    console.warn('[爱奇艺暂停广告助手] 播放未完成：', error);
                });
            }
        } catch (error) {
            lastInputError = `${error.name || 'Error'}: ${error.message || error}`;
            console.warn('[爱奇艺暂停广告助手] 播放控制失败：', error);
        }
    }

    function installInputControl() {
        window.addEventListener('pointerdown', event => {
            pointerStart = null;
            if (!event.isTrusted || event.button !== 0 || event.ctrlKey || event.altKey || event.metaKey) return;
            const video = inputVideo();
            if (video && pictureTarget(event, video)) {
                // 网站可能在 pointerup 就切换状态；使用按下时的状态，避免一次点击切换两次。
                pointerStart = { video, paused: video.paused, x: event.clientX, y: event.clientY, time: performance.now() };
            }
        }, true);
        window.addEventListener('click', event => {
            if (!event.isTrusted || event.button !== 0 || event.detail === 0 || event.ctrlKey || event.altKey || event.metaKey) return;
            const video = inputVideo();
            if (!video || !pictureTarget(event, video)) return;
            const start = pointerStart;
            pointerStart = null;
            if (start?.video === video && performance.now() - start.time < 1500 &&
                Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) return;
            const pausedBeforeClick = start?.video === video && performance.now() - start.time < 1500 ? start.paused : video.paused;
            consume(event);
            setPlayback(video, !pausedBeforeClick, '画面单击');
            // 不拦截 dblclick；双击全屏仍交给网页自己的处理程序。
        }, true);
        const isSpace = event => event.code === 'Space' || event.key === ' ';
        window.addEventListener('keydown', event => {
            if (!event.isTrusted || !isSpace(event)) return;
            if (spaceConsumed && event.repeat) { consume(event); return; }
            if (event.repeat || event.isComposing || event.ctrlKey || event.altKey || event.metaKey) return;
            const target = event.target;
            if (target instanceof Element && target.closest(EDITABLE + ',button,a,[role="button"],[role="dialog"]')) return;
            const video = inputVideo();
            if (!video) return;
            const scope = inputScope(video);
            if (target !== document.body && target !== root && !scope?.contains(target)) return;
            spaceConsumed = true;
            consume(event);
            setPlayback(video, !video.paused, '空格');
        }, true);
        // 同时挡住网页在 keypress/keyup 中再次切换，长按空格只切换一次。
        window.addEventListener('keypress', event => {
            if (event.isTrusted && isSpace(event) && spaceConsumed) consume(event);
        }, true);
        window.addEventListener('keyup', event => {
            if (!event.isTrusted || !isSpace(event) || !spaceConsumed) return;
            spaceConsumed = false;
            consume(event);
        }, true);
        window.addEventListener('blur', () => { pointerStart = null; spaceConsumed = false; });
    }

    function layoutDrifted() {
        if (!baseline?.video.isConnected || !baseline.boundary.isConnected) return false;
        const rect = baseline.video.getBoundingClientRect();
        const boundaryRect = baseline.boundary.getBoundingClientRect();
        const sx = boundaryRect.width / baseline.boundaryWidth;
        const sy = boundaryRect.height / baseline.boundaryHeight;
        return Math.abs(rect.width - baseline.width * sx) > 2 ||
            Math.abs(rect.height - baseline.height * sy) > 2 ||
            Math.abs(rect.left - boundaryRect.left - baseline.dx * sx) > 2 ||
            Math.abs(rect.top - boundaryRect.top - baseline.dy * sy) > 2;
    }

    function retryAfter(delay) {
        if (retryTimer) return;
        retryTimer = setTimeout(() => { retryTimer = 0; process(); }, Math.max(20, delay));
    }

    function rememberButtons(buttons) {
        const current = new Set(buttons);
        for (const button of visibleButtons) {
            if (!current.has(button)) lastAttempt.delete(button);
        }
        visibleButtons = current;
    }

    function geometryValue(property, computed, parentStyle) {
        const value = computed.getPropertyValue(property);
        // 原本铺满父容器的层仍使用百分比；全屏时不再沿用旧的固定像素尺寸。
        if ((property === 'width' || property === 'height') && parentStyle &&
            /^-?[\d.]+px$/.test(value) &&
            Math.abs(parseFloat(value) - parseFloat(parentStyle.getPropertyValue(property))) < 1) {
            return '100%';
        }
        if (/^-?[\d.]+px$/.test(value)) {
            const axis = X_LENGTHS.has(property) ? 'x' : Y_LENGTHS.has(property) ? 'y' : null;
            if (axis) return `calc(${value} * var(--iqiyi-pause-scale-${axis}, 1))`;
        }
        return value;
    }

    function observeBoundary(boundary) {
        if (!resizeObserver || observedBoundary === boundary) return;
        resizeObserver.disconnect();
        observedBoundary = boundary;
        observedWidth = boundary.clientWidth;
        observedHeight = boundary.clientHeight;
        resizeObserver.observe(boundary);
    }

    function captureBaseline(preferred, force = false, allowPaused = false) {
        if (guarded || (pauseArmed && !allowPaused) || activeButtons().length) return;
        if (!force && baseline?.video.isConnected && baseline.nodes.every(node => node.isConnected) &&
            performance.now() - lastCaptureAt < 250) return;
        const video = chooseVideo(preferred);
        if (!video) return;
        if (!video.paused) playedVideos.add(video);
        const videoRect = video.getBoundingClientRect();
        if (videoRect.width < 160 || videoRect.height < 90) return;

        // 实际 bridge 在 #outlayer 外；以可伸缩的左侧播放区为尺寸参照。
        // 不锁住播放区的宽高，否则侧栏收起或全屏后仍会保留旧尺寸。
        const overlay = document.querySelector('#outlayer');
        const fullscreen = document.fullscreenElement;
        const candidates = [video.closest('#areaLeftContainer'), video.closest('#video'), video.closest('#areaContainer')];
        const playerBoundary = candidates.find(node => node && (!fullscreen || fullscreen.contains(node))) ||
            (fullscreen?.contains(video) ? fullscreen : null);
        const nodes = [];
        for (let node = video; node && node !== document.body && node !== root; node = node.parentElement) {
            nodes.push(node);
            if (playerBoundary ? node === playerBoundary : overlay && node.contains(overlay)) break;
        }
        if (!nodes.length) return;
        const boundary = nodes[nodes.length - 1];
        const boundaryRect = boundary.getBoundingClientRect();
        if (!boundaryRect.width || !boundaryRect.height) return;

        const snapshots = nodes.map(node => {
            const computed = getComputedStyle(node);
            const parentStyle = node.parentElement ? getComputedStyle(node.parentElement) : null;
            const properties = node === boundary ? BOUNDARY_GEOMETRY : GEOMETRY;
            const geometry = properties.map(property => {
                const value = geometryValue(property, computed, parentStyle);
                return value ? `${property}:${value}!important;` : '';
            }).join('');
            // 只保护原生视频的画面可见性，不锁住外层控制界面的显示状态。
            const picture = node === video ? `visibility:${computed.visibility}!important;opacity:${computed.opacity}!important;` : '';
            return { node, declarations: geometry + picture };
        });
        const signature = snapshots.map(item => item.declarations).join('|');
        lastCaptureAt = performance.now();
        if (baseline?.video === video && baseline.nodes.length === nodes.length &&
            nodes.every((node, index) => node === baseline.nodes[index]) && baseline.signature === signature &&
            baseline.viewportEpoch === viewportEpoch) return;

        if (baseline) baseline.nodes.forEach(node => node.removeAttribute(MARK));
        const id = String(++token);
        layoutStyle.textContent = snapshots.map((item, index) => {
            const key = `${id}-${index}`;
            item.node.setAttribute(MARK, key);
            return `html[${GUARD}] [${MARK}="${key}"]{${item.declarations}}`;
        }).join('\n');
        baseline = {
            video, boundary, nodes, signature, viewportEpoch,
            scaleX: 1, scaleY: 1,
            width: videoRect.width, height: videoRect.height,
            dx: videoRect.left - boundaryRect.left,
            dy: videoRect.top - boundaryRect.top,
            boundaryWidth: boundaryRect.width, boundaryHeight: boundaryRect.height
        };
        observeBoundary(boundary);
        root.setAttribute('data-iqiyi-pause-baseline', 'ready');
    }

    function syncGeometryScale() {
        if (!baseline?.boundary.isConnected) return;
        const rect = baseline.boundary.getBoundingClientRect();
        const sx = rect.width / baseline.boundaryWidth;
        const sy = rect.height / baseline.boundaryHeight;
        if (!Number.isFinite(sx) || !Number.isFinite(sy) || sx <= 0 || sy <= 0) return;
        if (Math.abs(sx - baseline.scaleX) < 0.0001 && Math.abs(sy - baseline.scaleY) < 0.0001) return;
        baseline.scaleX = sx;
        baseline.scaleY = sy;
        const rules = layoutStyle.textContent.replace(/^html\[data-iqiyi-pause-guard\]\{--iqiyi-pause-scale-x:[^\n]+\}\n/, '');
        layoutStyle.textContent = `html[${GUARD}]{--iqiyi-pause-scale-x:${sx};--iqiyi-pause-scale-y:${sy};}\n` + rules;
    }

    function releaseLayout() {
        root.removeAttribute(GUARD);
        guarded = false;
    }

    function protectLayout() {
        if (!baseline?.video.isConnected || !baseline.boundary.isConnected) return;
        if (!guarded) {
            guarded = true;
            naturalRestored = false;
            root.setAttribute(GUARD, 'on');
        }
        syncGeometryScale();
    }

    function releaseIfRestored() {
        if (!guarded) return true;
        if (!baseline?.video.isConnected || !baseline.boundary.isConnected) {
            releaseLayout();
            pauseArmed = false;
            naturalRestored = false;
            baseline = null;
            return false;
        }

        // 在同一次 JS 调用里检查网站的自然布局，然后立即恢复保护。
        // 浏览器不会在中间绘制；过渡动画仍由独立的提前样式禁用。
        let natural;
        let boundaryRect;
        let visible;
        const expectedBoundary = baseline.boundary.getBoundingClientRect();
        layoutStyle.disabled = true;
        try {
            natural = baseline.video.getBoundingClientRect();
            boundaryRect = baseline.boundary.getBoundingClientRect();
            visible = isShown(baseline.video);
        } finally {
            layoutStyle.disabled = false;
        }
        const sx = expectedBoundary.width / baseline.boundaryWidth;
        const sy = expectedBoundary.height / baseline.boundaryHeight;
        const close = (a, b) => Math.abs(a - b) <= 2;
        naturalRestored = visible && close(boundaryRect.width, expectedBoundary.width) &&
            close(boundaryRect.height, expectedBoundary.height) && close(natural.width, baseline.width * sx) &&
            close(natural.height, baseline.height * sy) &&
            close(natural.left - boundaryRect.left, baseline.dx * sx) &&
            close(natural.top - boundaryRect.top, baseline.dy * sy);
        if (naturalRestored) {
            if (cyclePending) {
                cyclePending = false;
                restored += 1;
                root.setAttribute('data-iqiyi-pause-helper-restored', String(restored));
            }
            // 网站一恢复正常布局就解除保护；暂停本身不再持续锁定布局。
            releaseLayout();
        } else {
            cyclePending = true;
        }
        return naturalRestored;
    }

    function viewportChanged() {
        viewportEpoch += 1;
        // Firefox 的全屏事件与播放器自身的尺寸更新可能不在同一帧。
        // 在短暂的布局调整期连续更新基准，不只读取事件发生时的一次尺寸。
        viewportUntil = performance.now() + 650;
        if (!cyclePending && !activeButtons().length) releaseLayout();
        process(true);
    }

    function requestFrame() {
        if (frame || document.visibilityState === 'hidden') return;
        frame = requestAnimationFrame(() => {
            frame = 0;
            process();
        });
    }

    function process(forceCapture = false) {
        if (!root || busy || document.visibilityState === 'hidden') return;
        busy = true;
        try {
            const main = baseline?.video;
            if (main?.isConnected) {
                if (!main.paused) {
                    playedVideos.add(main);
                    pauseArmed = false;
                } else if (!main.ended && playedVideos.has(main)) {
                    // paused 属性先于 pause 事件更新；即使网站先移动外层，
                    // 也在本次微任务绘制前启用旧的正常尺寸，而不是重新学习小画面。
                    pauseArmed = true;
                }
            }
            const buttons = activeButtons();
            rememberButtons(buttons);
            const changingViewport = performance.now() < viewportUntil && !cyclePending && !buttons.length;
            if (changingViewport) {
                releaseLayout();
                captureBaseline(undefined, true, true);
                requestFrame();
                return;
            }
            // 暂停时保留正常基准，但只在当前任务检查/关闭广告期间临时保护。
            // 后续若广告才开始移动播放器，观察器会在绘制前重新启用保护。
            if (guarded || buttons.length || (pauseArmed && (forceCapture === true || layoutDrifted()))) protectLayout();
            if (!buttons.length) {
                releaseIfRestored();
                if (!guarded) captureBaseline(undefined, forceCapture === true);
            } else {
                cyclePending = true;
                protectLayout();
                const canClose = (!main || main.paused) && performance.now() >= resumeUntil;
                for (const button of canClose ? buttons : []) {
                    const now = performance.now();
                    const previous = lastAttempt.get(button);
                    const count = previous?.session === pauseSession ? previous.count : 0;
                    // 关闭过程可能仍保留按钮。反复点击会重新触发页面关闭流程。
                    // 仅在按钮迟迟没有消失时退避重试；每次暂停、每个按钮最多三次。
                    if (count >= 3) continue;
                    const interval = 1000 * Math.pow(2, Math.max(0, count - 1));
                    if (count && now - previous.time < interval) {
                        retryAfter(interval - (now - previous.time));
                        continue;
                    }
                    lastAttempt.set(button, { time: now, count: count + 1, session: pauseSession });
                    attempts += 1;
                    try {
                        button.click();
                    } catch (error) {
                        console.warn('[爱奇艺暂停广告助手] 点击失败：', error);
                    }
                }
                // 即使关闭按钮暂未移除，只要自然布局已恢复也立即解除保护。
                releaseIfRestored();
                const remaining = activeButtons();
                rememberButtons(remaining);
                if (canClose && remaining.length) retryAfter(1000);
            }
            if (guarded && !naturalRestored) requestFrame();
        } finally {
            busy = false;
        }
    }

    function start() {
        root = document.documentElement;
        if (!root || root.getAttribute('data-iqiyi-pause-helper') === VERSION) return;
        root.setAttribute('data-iqiyi-pause-helper', VERSION);
        if (!earlyStyle?.isConnected) {
            earlyStyle = document.createElement('style');
            earlyStyle.textContent = EARLY_CSS;
            root.appendChild(earlyStyle);
        }
        layoutStyle = document.createElement('style');
        root.appendChild(layoutStyle);
        if (typeof ResizeObserver === 'function') {
            resizeObserver = new ResizeObserver(() => {
                const node = observedBoundary;
                if (!node?.isConnected) return;
                const w = node.clientWidth;
                const h = node.clientHeight;
                if (Math.abs(w - observedWidth) < 1 && Math.abs(h - observedHeight) < 1) return;
                observedWidth = w;
                observedHeight = h;
                viewportChanged();
            });
        }

        installInputControl();
        // 广告和视频祖先的变化仍在微任务中处理；弹幕、字幕、进度数字等
        // 无关更新不再反复开关保护样式和强制重算播放器布局。
        new MutationObserver(records => {
            let relevant = !baseline?.video.isConnected;
            let layoutChanged = false;
            for (const record of records) {
                const target = record.target;
                if (target === layoutStyle || target === earlyStyle || target.nodeName === 'STYLE') continue;
                if (record.type === 'attributes' && baseline && target instanceof Element &&
                    (baseline.nodes.includes(target) || target.contains(baseline.boundary))) {
                    relevant = true;
                    layoutChanged = true;
                }
                if (target instanceof Element && target.closest('#outlayer') &&
                    target.closest('.flash-max1,.pause-main.maxPauseAd-container,.pause-max-close-area')) relevant = true;
                if (record.type === 'childList') {
                    for (const node of [...record.addedNodes, ...record.removedNodes]) {
                        if (node instanceof Element && (node.matches('video,#outlayer,.pause-max-close-btn') ||
                            node.querySelector('video,#outlayer,.pause-max-close-btn'))) relevant = true;
                    }
                }
            }
            if (relevant) process(layoutChanged);
        }).observe(root, {
            childList: true, subtree: true, attributes: true,
            attributeFilter: ['class', 'style', 'hidden']
        });
        const remember = event => captureBaseline(event.target, true);
        const playing = event => {
            if (event.target.tagName !== 'VIDEO' || (baseline && baseline.video !== event.target)) return;
            playedVideos.add(event.target);
            pauseArmed = false;
            process();
            captureBaseline(event.target, true);
        };
        document.addEventListener('play', playing, true);
        document.addEventListener('playing', playing, true);
        document.addEventListener('loadeddata', remember, true);
        document.addEventListener('pointerdown', remember, true);
        document.addEventListener('keydown', remember, true);
        document.addEventListener('pause', event => {
            if (event.target.tagName !== 'VIDEO') return;
            if (!baseline) captureBaseline(event.target, true);
            if (baseline?.video === event.target) {
                pauseSession += 1;
                playedVideos.add(event.target);
                pauseArmed = true;
                viewportUntil = 0;
                protectLayout();
            }
            process();
        }, true);
        document.addEventListener('visibilitychange', process);
        window.addEventListener('pageshow', process);
        window.addEventListener('resize', viewportChanged);
        document.addEventListener('fullscreenchange', viewportChanged);
        // 兜底处理异步播放器和同页切换剧集，正常检测不等待该定时器。
        setInterval(process, 750);

        if (typeof GM_registerMenuCommand === 'function') {
            GM_registerMenuCommand('查看暂停广告助手状态', () => {
                window.alert([
                    `暂停广告助手 v${VERSION}：无闪现模式`,
                    `已记录正片原尺寸：${baseline ? '是' : '否'}`,
                    `保护层级：${baseline?.nodes.length || 0} 层（包含真实播放器外层）`,
                    `临时画面保护：${guarded ? '等待广告布局恢复' : '已解除，原生操作'}`,
                    `尺寸调整：${performance.now() < viewportUntil ? '正在重新计算' : '完成'}`,
                    `网页自身布局：${guarded && !naturalRestored ? '等待恢复' : '正常'}`,
                    `当前活动关闭按钮：${activeButtons().length} 个`,
                    `最近输入：${lastInput}`,
                    `正片实际状态：${baseline?.video.paused ? '暂停' : '播放'}`,
                    `播放接口错误：${lastInputError || '无'}`,
                    `本页点击尝试：${attempts} 次`,
                    `已确认布局恢复：${restored} 次`
                ].join('\n'));
            });
            GM_registerMenuCommand('立即重新检测暂停广告', process);
        }
        process();
    }

    if (document.documentElement) start();
    else {
        const waiting = new MutationObserver(() => {
            if (document.documentElement) {
                waiting.disconnect();
                start();
            }
        });
        waiting.observe(document, { childList: true });
    }
})();
