// stl_analyzer.js — сервис анализа STL/STEP файлов
// Определяет габариты модели и объём

'use strict';

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const os    = require('os');

/**
 * Скачивает файл и анализирует размеры STL.
 * Возвращает { x, y, z, volumeCm3 } или null если не удалось.
 */
async function analyze(fileUrl) {
  try {
    const tmpPath = path.join(os.tmpdir(), `stl_${Date.now()}.stl`);
    await downloadFile(fileUrl, tmpPath);
    const result = parseBinaryStl(tmpPath);
    fs.unlinkSync(tmpPath);
    return result;
  } catch (err) {
    console.error('[STL Analyzer]', err.message);
    return null;
  }
}

/**
 * Парсит бинарный STL и возвращает bounding box + объём.
 */
function parseBinaryStl(filePath) {
  const buf = fs.readFileSync(filePath);

  // STL: 80 байт заголовок + 4 байта кол-во треугольников
  if (buf.length < 84) throw new Error('Файл слишком мал для STL');

  const triangleCount = buf.readUInt32LE(80);
  const expectedSize  = 84 + triangleCount * 50;

  // Проверяем что это бинарный STL (не ASCII)
  if (buf.length < expectedSize) {
    // Возможно ASCII STL — используем эвристику
    return parseAsciiStlEstimate(buf.toString('utf8', 0, Math.min(buf.length, 50000)));
  }

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let volume = 0;

  for (let i = 0; i < triangleCount; i++) {
    const offset = 84 + i * 50 + 12; // пропускаем нормаль (12 байт)

    const vertices = [];
    for (let v = 0; v < 3; v++) {
      const x = buf.readFloatLE(offset + v * 12);
      const y = buf.readFloatLE(offset + v * 12 + 4);
      const z = buf.readFloatLE(offset + v * 12 + 8);
      vertices.push({ x, y, z });
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }

    // Вычисляем объём через signed tetrahedra
    const [v0, v1, v2] = vertices;
    volume += signedVolumeOfTriangle(v0, v1, v2);
  }

  const x = maxX - minX;
  const y = maxY - minY;
  const z = maxZ - minZ;
  const volumeMm3 = Math.abs(volume);
  const volumeCm3 = volumeMm3 / 1000;

  return { x, y, z, volumeCm3 };
}

function signedVolumeOfTriangle(p1, p2, p3) {
  return (
    p1.x * (p2.y * p3.z - p3.y * p2.z) -
    p2.x * (p1.y * p3.z - p3.y * p1.z) +
    p3.x * (p1.y * p2.z - p2.y * p1.z)
  ) / 6.0;
}

function parseAsciiStlEstimate(content) {
  // Для ASCII STL — парсим вершины
  const vertexRe = /vertex\s+([-\d.e+]+)\s+([-\d.e+]+)\s+([-\d.e+]+)/gi;
  let match;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let count = 0;

  while ((match = vertexRe.exec(content)) !== null) {
    const x = parseFloat(match[1]);
    const y = parseFloat(match[2]);
    const z = parseFloat(match[3]);
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    count++;
  }

  if (count < 3) return null;

  const x = maxX - minX;
  const y = maxY - minY;
  const z = maxZ - minZ;
  // Для ASCII STL считаем объём приближённо как 30% bounding box
  const volumeCm3 = (x * y * z * 0.3) / 1000;

  return { x, y, z, volumeCm3 };
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const file  = fs.createWriteStream(destPath);
    proto.get(url, res => {
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', reject);
    }).on('error', reject);
  });
}

module.exports = { analyze };
