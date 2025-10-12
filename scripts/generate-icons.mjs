import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

(async () => {
  try {
    // Assume script is run from project root
    const root = process.cwd();
    const srcIcon = path.resolve(root, 'icons', 'source.png');
    const outDir = path.resolve(root, 'icons');
    if (!fs.existsSync(srcIcon)) {
      console.error('[icons] Missing icons/source.png. Please add your original icon as icons/source.png');
      process.exit(1);
    }
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const sizes = [16, 32, 48, 128];
    for (const s of sizes) {
      const out = path.resolve(outDir, `icon${s}.png`);
      await sharp(srcIcon).resize(s, s, { fit: 'cover' }).png().toFile(out);
      console.log(`[icons] wrote ${out}`);
    }
    process.exit(0);
  } catch (e) {
    console.error('[icons] generation failed:', e);
    process.exit(1);
  }
})();


