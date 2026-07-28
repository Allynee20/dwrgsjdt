const input = document.querySelector('#imageInput');
const uploadView = document.querySelector('#uploadView');
const resultView = document.querySelector('#resultView');
const mapImage = document.querySelector('#mapImage');
const mapViewport = document.querySelector('#mapViewport');
const loadingState = document.querySelector('#loadingState');
const statusText = document.querySelector('#statusText');
const mapName = document.querySelector('#mapName');
const zoomValue = document.querySelector('#zoomValue');
const toast = document.querySelector('#errorToast');
const noticeDialog = document.querySelector('#noticeDialog');

let zoom = 1;
let fitScale = 1;
let panX = 0;
let panY = 0;
let pointers = new Map();
let lastDistance = 0;
let dragOrigin = null;

function setTransform() {
  mapImage.style.transform = `translate(calc(-50% + ${panX}px), calc(-50% + ${panY}px)) scale(${fitScale * zoom})`;
  zoomValue.value = `${Math.round(zoom * 100)}%`;
}

function setZoom(value) {
  zoom = Math.min(5, Math.max(0.35, value));
  setTransform();
}

function resetZoom() {
  if (mapImage.naturalWidth && mapImage.naturalHeight) {
    fitScale = Math.min(
      mapViewport.clientWidth / mapImage.naturalWidth,
      mapViewport.clientHeight / mapImage.naturalHeight
    ) * 0.94;
  }
  zoom = 1;
  panX = 0;
  panY = 0;
  setTransform();
}

function showError(message) {
  toast.textContent = message;
  toast.hidden = false;
  window.clearTimeout(showError.timer);
  showError.timer = window.setTimeout(() => { toast.hidden = true; }, 3500);
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function matchFile(file) {
  if (!file || !file.type.startsWith('image/')) {
    showError('请选择图片文件');
    return;
  }
  if (file.size > 15 * 1024 * 1024) {
    showError('图片不能超过 15 MB');
    return;
  }

  try {
    const dataUrl = await readAsDataUrl(file);
    document.body.classList.remove('select-mode');
    uploadView.hidden = true;
    resultView.hidden = false;
    loadingState.hidden = false;
    statusText.textContent = '正在匹配';
    mapName.textContent = '识别中';
    resetZoom();

    let result;
    const params = new URLSearchParams(location.search);
    const forceOnline = params.has('online');
    const forceOffline = params.has('offline');
    const canOffline = location.protocol === 'file:' || forceOffline || window.OfflineMatcher;
    if ((!forceOnline && canOffline) || forceOffline) {
      result = await window.OfflineMatcher.match(file);
    } else {
      try {
        const response = await fetch('/api/match', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image: dataUrl })
        });
        result = await response.json();
        if (!response.ok) throw new Error(result.error || '匹配失败');
      } catch (error) {
        if (window.OfflineMatcher) {
          result = await window.OfflineMatcher.match(file);
        } else {
          throw error;
        }
      }
    }

    mapName.textContent = `地图 ${result.mapNumber}`;
    statusText.textContent = result.confident ? '匹配完成' : '已返回最接近结果';
    mapImage.onload = resetZoom;
    mapImage.src = `${result.mapUrl}?v=${Date.now()}`;
  } catch (error) {
    uploadView.hidden = false;
    resultView.hidden = true;
    document.body.classList.add('select-mode');
    statusText.textContent = '等待选择截图';
    showError(error.message || '图片处理失败');
  } finally {
    loadingState.hidden = true;
  }
}

input.addEventListener('change', () => matchFile(input.files[0]));
document.querySelector('#replaceButton').addEventListener('click', () => {
  input.value = '';
  input.click();
});
document.querySelector('#zoomIn').addEventListener('click', () => setZoom(zoom * 1.25));
document.querySelector('#zoomOut').addEventListener('click', () => setZoom(zoom / 1.25));
document.querySelector('#zoomReset').addEventListener('click', resetZoom);
document.querySelector('#noticeButton').addEventListener('click', () => noticeDialog.showModal());
document.querySelector('#noticeClose').addEventListener('click', () => noticeDialog.close());
noticeDialog.addEventListener('click', (event) => {
  if (event.target === noticeDialog) noticeDialog.close();
});

mapViewport.addEventListener('wheel', (event) => {
  event.preventDefault();
  setZoom(zoom * (event.deltaY < 0 ? 1.12 : 0.89));
}, { passive: false });

mapViewport.addEventListener('pointerdown', (event) => {
  mapViewport.setPointerCapture(event.pointerId);
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (pointers.size === 1) dragOrigin = { x: event.clientX - panX, y: event.clientY - panY };
});

mapViewport.addEventListener('pointermove', (event) => {
  if (!pointers.has(event.pointerId)) return;
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  const points = [...pointers.values()];
  if (points.length === 2) {
    const distance = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
    if (lastDistance) setZoom(zoom * distance / lastDistance);
    lastDistance = distance;
  } else if (points.length === 1 && dragOrigin) {
    panX = event.clientX - dragOrigin.x;
    panY = event.clientY - dragOrigin.y;
    setTransform();
  }
});

function releasePointer(event) {
  pointers.delete(event.pointerId);
  lastDistance = 0;
  dragOrigin = null;
}
mapViewport.addEventListener('pointerup', releasePointer);
mapViewport.addEventListener('pointercancel', releasePointer);
