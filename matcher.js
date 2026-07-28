(function () {
  'use strict';

  const SCALES = [0.25, 0.30, 0.35, 0.42, 0.50, 0.58, 0.66, 0.74, 0.82, 0.90, 1.0, 1.10, 1.20, 1.35, 1.50, 1.70];
  const maskCache = new Map();

  function loadImage(source) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('图片读取失败'));
      image.src = source;
    });
  }

  async function fileToImage(file) {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('图片读取失败'));
      reader.readAsDataURL(file);
    });
    return loadImage(dataUrl);
  }

  function imagePixels(image, maxDimension = 1200) {
    const shrink = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.max(1, Math.round(image.naturalWidth * shrink));
    const height = Math.max(1, Math.round(image.naturalHeight * shrink));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0, width, height);
    return { width, height, shrink, data: context.getImageData(0, 0, width, height).data };
  }

  function grayPixels(rgba, size) {
    const gray = new Uint8Array(size);
    for (let i = 0, p = 0; i < size; i++, p += 4) {
      gray[i] = Math.round((rgba[p] + rgba[p + 1] + rgba[p + 2]) / 3);
    }
    return gray;
  }

  function otsu(gray) {
    const histogram = new Uint32Array(256);
    for (let i = 0; i < gray.length; i++) histogram[gray[i]]++;
    let totalValue = 0;
    for (let i = 0; i < 256; i++) totalValue += i * histogram[i];
    let backgroundWeight = 0;
    let backgroundValue = 0;
    let bestVariance = -1;
    let threshold = 0;
    for (let i = 0; i < 256; i++) {
      backgroundWeight += histogram[i];
      if (!backgroundWeight) continue;
      const foregroundWeight = gray.length - backgroundWeight;
      if (!foregroundWeight) break;
      backgroundValue += i * histogram[i];
      const backgroundMean = backgroundValue / backgroundWeight;
      const foregroundMean = (totalValue - backgroundValue) / foregroundWeight;
      const variance = backgroundWeight * foregroundWeight * (backgroundMean - foregroundMean) ** 2;
      if (variance > bestVariance) {
        bestVariance = variance;
        threshold = i;
      }
    }
    return threshold;
  }

  function boxMorph(mask, width, height, radius, dilate) {
    if (!radius) return mask.slice();
    const horizontal = new Uint8Array(mask.length);
    const output = new Uint8Array(mask.length);
    const required = radius * 2 + 1;
    for (let y = 0; y < height; y++) {
      let count = 0;
      const row = y * width;
      for (let x = -radius; x < width + radius; x++) {
        const add = x + radius;
        const remove = x - radius - 1;
        if (add >= 0 && add < width) count += mask[row + add];
        if (remove >= 0 && remove < width) count -= mask[row + remove];
        if (x >= 0 && x < width) horizontal[row + x] = dilate ? Number(count > 0) : Number(count === required);
      }
    }
    for (let x = 0; x < width; x++) {
      let count = 0;
      for (let y = -radius; y < height + radius; y++) {
        const add = y + radius;
        const remove = y - radius - 1;
        if (add >= 0 && add < height) count += horizontal[add * width + x];
        if (remove >= 0 && remove < height) count -= horizontal[remove * width + x];
        if (y >= 0 && y < height) output[y * width + x] = dilate ? Number(count > 0) : Number(count === required);
      }
    }
    return output;
  }

  function closeOpen(mask, width, height) {
    let result = boxMorph(mask, width, height, 5, true);
    result = boxMorph(result, width, height, 5, false);
    result = boxMorph(result, width, height, 1, false);
    return boxMorph(result, width, height, 1, true);
  }

  function components(mask, width, height) {
    const labels = new Int32Array(mask.length);
    const queue = new Int32Array(mask.length);
    const stats = [{ area: 0, x: 0, y: 0, width: 0, height: 0, cx: 0, cy: 0 }];
    let label = 0;
    for (let start = 0; start < mask.length; start++) {
      if (!mask[start] || labels[start]) continue;
      label++;
      let head = 0;
      let tail = 0;
      queue[tail++] = start;
      labels[start] = label;
      let area = 0;
      let minX = width;
      let minY = height;
      let maxX = 0;
      let maxY = 0;
      let sumX = 0;
      let sumY = 0;
      while (head < tail) {
        const index = queue[head++];
        const y = Math.floor(index / width);
        const x = index - y * width;
        area++;
        sumX += x;
        sumY += y;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= height) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = x + dx;
            if (nx < 0 || nx >= width) continue;
            const next = ny * width + nx;
            if (mask[next] && !labels[next]) {
              labels[next] = label;
              queue[tail++] = next;
            }
          }
        }
      }
      stats.push({ area, x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1, cx: sumX / area, cy: sumY / area });
    }
    return { labels, stats };
  }

  function prepareQuery(image) {
    const pixels = imagePixels(image);
    const { width, height, data, shrink } = pixels;
    const gray = grayPixels(data, width * height);
    const threshold = Math.max(54, otsu(gray) - 9);
    const bodyRaw = new Uint8Array(gray.length);
    const iconRaw = new Uint8Array(gray.length);
    for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
      bodyRaw[i] = Number(gray[i] > threshold);
      const max = Math.max(data[p], data[p + 1], data[p + 2]);
      const min = Math.min(data[p], data[p + 1], data[p + 2]);
      const saturation = max ? ((max - min) * 255) / max : 0;
      iconRaw[i] = Number(gray[i] > 82 && saturation < 105);
    }
    const body = closeOpen(bodyRaw, width, height);
    const bodyParts = components(body, width, height);
    const areaScale = shrink * shrink;
    let bodyBox = null;
    let bestBodyValue = -1;
    for (let i = 1; i < bodyParts.stats.length; i++) {
      const item = bodyParts.stats[i];
      if (item.area < 300 * areaScale || item.width > width * 0.85 || item.height > height * 0.90) continue;
      const distance = Math.abs(item.cx - width / 2) / width + Math.abs(item.cy - height / 2) / height;
      const value = item.area / (1 + distance);
      if (value > bestBodyValue) {
        bestBodyValue = value;
        bodyBox = item;
      }
    }
    const iconParts = components(iconRaw, width, height);
    let anchor = null;
    let anchorArea = -1;
    for (let i = 1; i < iconParts.stats.length; i++) {
      const item = iconParts.stats[i];
      const ratio = item.width / Math.max(item.height, 1);
      if (item.area < 80 * areaScale || item.area > 1200 * areaScale || item.width < 10 * shrink || item.width > 55 * shrink || item.height < 10 * shrink || item.height > 60 * shrink || ratio < 0.55 || ratio > 1.5) continue;
      if (item.y > height * 0.88 || item.y < height * 0.05 || item.x < width * 0.04 || item.x + item.width > width * 0.96) continue;
      if (bodyBox) {
        const pad = Math.max(8 * shrink, Math.min(bodyBox.width, bodyBox.height) * 0.04);
        if (item.cx < bodyBox.x - pad || item.cx > bodyBox.x + bodyBox.width + pad || item.cy < bodyBox.y - pad || item.cy > bodyBox.y + bodyBox.height + pad) continue;
      }
      if (item.area > anchorArea) {
        anchorArea = item.area;
        anchor = { x: item.cx, y: item.cy };
      }
    }
    if (!anchor) throw new Error('未识别到入口位置，请选择包含地图入口的截图');
    let component = bodyParts.labels[Math.max(0, Math.min(height - 1, Math.round(anchor.y))) * width + Math.max(0, Math.min(width - 1, Math.round(anchor.x)))];
    if (!component) {
      let nearest = Infinity;
      for (let i = 1; i < bodyParts.stats.length; i++) {
        const item = bodyParts.stats[i];
        if (item.area < 100 * areaScale) continue;
        const distance = Math.hypot(item.cx - anchor.x, item.cy - anchor.y);
        if (distance < nearest) {
          nearest = distance;
          component = i;
        }
      }
    }
    const box = bodyParts.stats[component];
    if (!box || box.area < 100 * areaScale) throw new Error('地图道路区域不完整');
    const cropped = new Uint8Array(box.width * box.height);
    for (let y = 0; y < box.height; y++) {
      for (let x = 0; x < box.width; x++) {
        cropped[y * box.width + x] = Number(bodyParts.labels[(box.y + y) * width + box.x + x] === component);
      }
    }
    return { mask: cropped, width: box.width, height: box.height, anchorX: anchor.x - box.x, anchorY: anchor.y - box.y, shrink };
  }

  async function loadMask(entry) {
    if (maskCache.has(entry.number)) return maskCache.get(entry.number);
    const image = await loadImage(entry.mask);
    const pixels = imagePixels(image, Number.MAX_SAFE_INTEGER);
    const mask = new Uint8Array(pixels.width * pixels.height);
    for (let i = 0, p = 0; i < mask.length; i++, p += 4) mask[i] = Number(pixels.data[p] > 127);
    const value = { mask, width: pixels.width, height: pixels.height };
    maskCache.set(entry.number, value);
    return value;
  }

  function scoreAtScale(query, target, entry, scale) {
    const effectiveScale = scale / query.shrink;
    const width = Math.max(8, Math.round(query.width * effectiveScale));
    const height = Math.max(8, Math.round(query.height * effectiveScale));
    const offsetX = Math.round(entry.anchorX - query.anchorX * effectiveScale);
    const offsetY = Math.round(entry.anchorY - query.anchorY * effectiveScale);
    const x0 = Math.max(0, offsetX);
    const y0 = Math.max(0, offsetY);
    const x1 = Math.min(target.width, offsetX + width);
    const y1 = Math.min(target.height, offsetY + height);
    if (x1 <= x0 || y1 <= y0 || ((x1 - x0) * (y1 - y0)) / (width * height) < 0.68) return -1;
    let intersection = 0;
    let union = 0;
    let agreement = 0;
    let count = 0;
    for (let y = y0; y < y1; y++) {
      const queryY = Math.min(query.height - 1, Math.max(0, Math.floor(((y - offsetY) + 0.5) / effectiveScale)));
      for (let x = x0; x < x1; x++) {
        const queryX = Math.min(query.width - 1, Math.max(0, Math.floor(((x - offsetX) + 0.5) / effectiveScale)));
        const a = query.mask[queryY * query.width + queryX] !== 0;
        const b = target.mask[y * target.width + x] !== 0;
        if (a && b) intersection++;
        if (a || b) union++;
        if (a === b) agreement++;
        count++;
      }
    }
    return 0.70 * intersection / Math.max(union, 1) + 0.30 * agreement / Math.max(count, 1);
  }

  async function match(file) {
    if (!window.OFFLINE_MAPS || !window.OFFLINE_MAPS.length) throw new Error('本地图库未加载');
    const image = await fileToImage(file);
    const query = prepareQuery(image);
    const rankings = [];
    for (const entry of window.OFFLINE_MAPS) {
      const target = await loadMask(entry);
      let score = -1;
      let bestScale = 0;
      for (const scale of SCALES) {
        const candidate = scoreAtScale(query, target, entry, scale);
        if (candidate > score) {
          score = candidate;
          bestScale = scale;
        }
      }
      rankings.push({ entry, score, scale: bestScale });
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    rankings.sort((a, b) => b.score - a.score || Number(a.entry.number) - Number(b.entry.number));
    const best = rankings[0];
    const margin = best.score - (rankings[1]?.score ?? best.score);
    return {
      mapNumber: String(best.entry.number),
      mapUrl: best.entry.map,
      score: best.score,
      margin,
      confident: best.score >= 0.50 && margin >= 0.025
    };
  }

  window.OfflineMatcher = { match };
})();
