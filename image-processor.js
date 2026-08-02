// image-processor.js
// Smart crop + compress for Quotex screenshots
// App এবং Browser উভয় থেকে কাজ করে

const sharp = require('sharp');

/**
 * Quotex screenshot থেকে শুধু chart area crop করে
 * App বা Browser যেকোনো source থেকে কাজ করে
 */
async function processQuotexScreenshot(imageBase64) {
  const inputBuffer = Buffer.from(imageBase64, 'base64');

  // Image metadata পড়ো
  const meta = await sharp(inputBuffer).metadata();
  const { width, height } = meta;

  console.log(`📐 Original: ${width}x${height}px, ${Math.round(inputBuffer.length/1024)}KB`);

  // ====== Smart Crop Calculation ======
  // Quotex layout (app + browser) তে:
  // Top: ~18-22% — status bar, balance, deposit button
  // Bottom: ~28-32% — pair selector, timer, up/down buttons, nav bar
  // Left: 0% — chart শুরু হয় বাম থেকেই
  // Right: 0% — price scale ডান পাশে থাকে (দরকার)

  // Percentage based (সব screen size এ কাজ করে)
  const topCrop = Math.round(height * 0.20);    // Top 20% কাটো
  const bottomCrop = Math.round(height * 0.30); // Bottom 30% কাটো
  const leftCrop = Math.round(width * 0.01);    // Left 1% কাটো
  const rightCrop = Math.round(width * 0.01);   // Right 1% কাটো

  const cropTop = topCrop;
  const cropLeft = leftCrop;
  const cropWidth = width - leftCrop - rightCrop;
  const cropHeight = height - topCrop - bottomCrop;

  // Minimum size check
  if (cropWidth < 100 || cropHeight < 100) {
    console.log('⚠️ Image too small to crop, using original');
    return await compressOnly(inputBuffer);
  }

  console.log(`✂️ Crop: top=${cropTop}px, height=${cropHeight}px (removed top ${Math.round(topCrop/height*100)}%, bottom ${Math.round(bottomCrop/height*100)}%)`);

  const cropped = await sharp(inputBuffer)
    .extract({
      left: cropLeft,
      top: cropTop,
      width: cropWidth,
      height: cropHeight
    })
    .resize({
      width: 900,
      withoutEnlargement: true
    })
    .jpeg({ quality: 78 })
    .toBuffer();

  console.log(`✅ Processed: ${Math.round(cropped.length/1024)}KB (was ${Math.round(inputBuffer.length/1024)}KB)`);

  return cropped.toString('base64');
}

/**
 * Crop ছাড়া শুধু compress করো (fallback)
 */
async function compressOnly(inputBuffer) {
  const compressed = await sharp(inputBuffer)
    .resize({ width: 900, withoutEnlargement: true })
    .jpeg({ quality: 78 })
    .toBuffer();
  return compressed.toString('base64');
}

/**
 * Main function — crop + compress
 */
async function processScreenshot(imageBase64, mimeType) {
  try {
    if (!imageBase64 || imageBase64.length < 100) {
      throw new Error('Invalid image data');
    }

    const inputBuffer = Buffer.from(imageBase64, 'base64');
    const inputSizeKB = inputBuffer.length / 1024;

    // 100KB এর নিচে হলে crop করো কিন্তু compress skip
    if (inputSizeKB < 100) {
      console.log('📸 Small image, crop only');
      return await processQuotexScreenshot(imageBase64);
    }

    return await processQuotexScreenshot(imageBase64);
  } catch (e) {
    console.error('❌ Image processing error:', e.message);
    // Error হলে original image return করো
    return imageBase64;
  }
}

module.exports = { processScreenshot };
