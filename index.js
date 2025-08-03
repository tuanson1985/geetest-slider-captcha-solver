const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

const fs = require("fs").promises;
const Jimp = require("jimp");
const { cv, ready } = require("opencv-wasm");
const https = require("https");

function downloadImage(url, filepath) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    client
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          return reject(
            new Error(`Không tải được ảnh '${url}' (${res.statusCode})`)
          );
        }
        const fileStream = require("fs").createWriteStream(filepath);
        res.pipe(fileStream);
        fileStream.on("finish", () => fileStream.close(resolve));
      })
      .on("error", reject);
  });
}

// Tạo path kéo chuột giống người dùng
function generateHumanLikePath(startX, endX, steps) {
  const path = [];
  const easeOutQuad = (t) => t * (2 - t);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const eased = easeOutQuad(t);
    const x = startX + (endX - startX) * eased;
    path.push(x);
  }
  return path;
}

// Tìm vị trí mảnh khuyết
async function findPuzzlePosition() {
  await ready;

  const bg = await Jimp.read("original.png");
  const slice = await Jimp.read("captcha.png");

  // Cắt viền mờ của slice
  const CROP_MARGIN = 4;
  if (
    slice.bitmap.width > CROP_MARGIN * 2 &&
    slice.bitmap.height > CROP_MARGIN * 2
  ) {
    slice.crop(
      CROP_MARGIN,
      CROP_MARGIN,
      slice.bitmap.width - CROP_MARGIN * 2,
      slice.bitmap.height - CROP_MARGIN * 2
    );
  }

  bg.rgba(false).grayscale().contrast(0.5).brightness(0.1);
  slice.rgba(false).grayscale().contrast(0.5).brightness(0.1);

  const bgMat = cv.matFromImageData(bg.bitmap);
  const sliceMat = cv.matFromImageData(slice.bitmap);
  const resultCols = bgMat.cols - sliceMat.cols + 1;
  const resultRows = bgMat.rows - sliceMat.rows + 1;
  const result = new cv.Mat(resultRows, resultCols, cv.CV_32FC1);

  cv.matchTemplate(bgMat, sliceMat, result, cv.TM_CCOEFF_NORMED);
  const minMax = cv.minMaxLoc(result);
  const { x, y } = minMax.maxLoc;

  // Vẽ debug
  const bgColor = await Jimp.read("original.png");
  const marker = new Jimp(slice.bitmap.width, slice.bitmap.height, 0xff0000ff);
  bgColor.composite(marker, x, y, {
    mode: Jimp.BLEND_SOURCE_OVER,
    opacitySource: 0.4,
  });
  await bgColor.writeAsync("debug_position.png");

  bgMat.delete();
  sliceMat.delete();
  result.delete();

  return [x, y];
}

// Lưu ảnh captcha từ web
async function saveSliderCaptchaImages(page) {
  await page.waitForSelector(".tab-item.tab-item-1");
  await page.click(".tab-item.tab-item-1");

  await page.waitForSelector('[aria-label="Click to verify"]');
  await page.waitFor(1000);

  await page.click('[aria-label="Click to verify"]');
  await page.waitFor(8000);

  const urls = await page.evaluate(() => {
    const getBackgroundUrl = (contains) => {
      const allDivs = Array.from(document.querySelectorAll("div"));
      for (let div of allDivs) {
        const bg = window.getComputedStyle(div).backgroundImage;
        if (bg && bg.includes(contains)) {
          const match = bg.match(/url\("?(.*?)"?\)/);
          return match ? match[1] : null;
        }
      }
      return null;
    };

    return {
      original: getBackgroundUrl("/bg/"),
      puzzle: getBackgroundUrl("/slice/"),
    };
  });

  console.log("🧩 Ảnh nền:", urls.original);
  console.log("🧩 Mảnh ghép:", urls.puzzle);

  if (!urls.original || !urls.puzzle) {
    throw new Error("❌ Không tìm thấy URL ảnh captcha");
  }

  await downloadImage(urls.original, "./original.png");
  await downloadImage(urls.puzzle, "./captcha.png");
}

// Hàm chính
async function run() {
  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    args: ["--start-maximized"],
  });

  const page = await browser.newPage();

  try {
    await page.goto("https://www.geetest.com/en/demo", {
      waitUntil: "networkidle2",
    });

    await page.waitFor(1000);

    await saveSliderCaptchaImages(page);

    const [targetX] = await findPuzzlePosition();
    console.log("📍 Vị trí cần kéo tới (X):", targetX);

    const sliderHandle = await page.$(".geetest_slider .geetest_btn");
    if (!sliderHandle) {
      throw new Error("❌ Không tìm thấy phần tử slider");
    }

    const handle = await sliderHandle.boundingBox();

    let xPosition = handle.x + handle.width / 2;
    let yPosition = handle.y + handle.height / 2;

    await page.mouse.move(xPosition, yPosition);
    await page.mouse.down();

    const dragDistance = targetX;
    console.log(`↔️ Khoảng cách cần kéo: ${dragDistance}px`);

    const steps = 25;
    const path = generateHumanLikePath(
      xPosition,
      xPosition + dragDistance,
      steps
    );

    for (let x of path) {
      yPosition = handle.y + handle.height / 2 + (Math.random() * 2 - 1);
      await page.mouse.move(x, yPosition);
      await page.waitFor(10 + Math.random() * 30);
    }

    await page.waitFor(300);
    await page.mouse.up();

    await page.waitFor(3000);

    const success = await page.evaluate(() => {
      return document.querySelector(".geetest_success") !== null;
    });

    if (success) {
      console.log("✅ Xác minh thành công!");
    } else {
      console.log("❌ Xác minh thất bại");
    }
  } catch (error) {
    console.error("❌ Lỗi:", error);
  } finally {
    await browser.close();
  }
}

run();
