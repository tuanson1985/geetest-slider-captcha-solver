const puppeteer = require('puppeteer')
const fs = require('fs').promises
const Jimp = require('jimp')
const pixelmatch = require('pixelmatch')
const { cv } = require('opencv-wasm')
const https = require('https');
const { log } = require('console')

async function findPuzzlePosition() {
    let original, puzzle;

    try {
        original = await Jimp.read('original.png');
    } catch (e) {
        throw new Error('Không thể đọc file original.png: ' + e.message);
    }

    try {
        puzzle = await Jimp.read('captcha.png');
    } catch (e) {
        throw new Error('Không thể đọc file captcha.png: ' + e.message);
    }

    const width = Math.min(original.bitmap.width, puzzle.bitmap.width);
    const height = Math.min(original.bitmap.height, puzzle.bitmap.height);

    original.resize(width, height);
    puzzle.resize(width, height);

    const { data: img1 } = original.bitmap;
    const { data: img2 } = puzzle.bitmap;

    const diff = Buffer.alloc(img1.length);
    pixelmatch(img1, img2, diff, width, height, { threshold: 0.1 });

    for (let x = 0; x < width; x++) {
        for (let y = 0; y < height; y++) {
            const idx = (y * width + x) * 4;
            const r = diff[idx];
            const g = diff[idx + 1];
            const b = diff[idx + 2];

            if (r !== 0 || g !== 0 || b !== 0) {
                return [x, y]; // ✅ trả về mảng gồm x và y
            }
        }
    }

    throw new Error('Không tìm thấy vị trí cần kéo');
}

async function findDiffPosition() {
    await new Promise(resolve => setTimeout(resolve, 100)) // Sửa lại delay cho Puppeteer

    const srcImage = await Jimp.read('./diff.png')
    const src = cv.matFromImageData(srcImage.bitmap)

    const dst = new cv.Mat()
    const kernel = cv.Mat.ones(5, 5, cv.CV_8UC1)
    const anchor = new cv.Point(-1, -1)

    cv.threshold(src, dst, 127, 255, cv.THRESH_BINARY)
    cv.erode(dst, dst, kernel, anchor, 1)
    cv.dilate(dst, dst, kernel, anchor, 1)
    cv.erode(dst, dst, kernel, anchor, 1)
    cv.dilate(dst, dst, kernel, anchor, 1)

    cv.cvtColor(dst, dst, cv.COLOR_BGR2GRAY)
    cv.threshold(dst, dst, 150, 255, cv.THRESH_BINARY_INV)

    const contours = new cv.MatVector()
    const hierarchy = new cv.Mat()
    cv.findContours(dst, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE)

    if (contours.size() === 0) {
        console.warn('⚠️ Không tìm thấy contour nào trong ảnh diff')
        src.delete(); dst.delete(); kernel.delete(); contours.delete(); hierarchy.delete()
        return null
    }

    const contour = contours.get(0)
    const moment = cv.moments(contour)

    // Giải phóng bộ nhớ
    src.delete(); dst.delete(); kernel.delete(); contours.delete(); hierarchy.delete()

    return [
        Math.floor(moment.m10 / moment.m00),
        Math.floor(moment.m01 / moment.m00)
    ]
}

function downloadImage(url, filepath) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http
        client.get(url, res => {
            if (res.statusCode !== 200) {
                return reject(new Error(`Failed to get '${url}' (${res.statusCode})`))
            }
            const fileStream = require('fs').createWriteStream(filepath)
            res.pipe(fileStream)
            fileStream.on('finish', () => fileStream.close(resolve))
        }).on('error', reject)
    })
}

async function saveSliderCaptchaImages(page) {
    await page.waitForSelector('.tab-item.tab-item-1')
    await page.click('.tab-item.tab-item-1')

    await page.waitForSelector('[aria-label="Click to verify"]')
    await page.waitFor(1000)

    await page.click('[aria-label="Click to verify"]')
    await page.waitFor(10000)

    const urls = await page.evaluate(() => {
        const getBackgroundUrl = (contains) => {
            const allDivs = Array.from(document.querySelectorAll('div'))
            for (let div of allDivs) {
                const bg = window.getComputedStyle(div).backgroundImage
                if (bg && bg.includes(contains)) {
                    const match = bg.match(/url\("?(.*?)"?\)/)
                    return match ? match[1] : null
                }
            }
            return null
        }

        return {
            original: getBackgroundUrl('/bg/'),
            puzzle: getBackgroundUrl('/slice/')
        }
    })

    console.log('🧩 Ảnh nền:', urls.original)
    console.log('🧩 Ảnh mảnh ghép:', urls.puzzle)

    if (!urls.original || !urls.puzzle) {
        throw new Error("Không tìm thấy URL ảnh captcha")
    }

    await downloadImage(urls.original, './original.png')
    await downloadImage(urls.puzzle, './captcha.png')

    // await fs.writeFile(`./captcha.png`, images[0], 'base64')
    // await fs.writeFile(`./original.png`, images[2], 'base64')
}

async function saveDiffImage() {
    // Đọc hai ảnh đã tải về từ Geetest
    const originalImage = await Jimp.read('./original.png')
    const captchaImage = await Jimp.read('./captcha.png')

    // Lấy kích thước
    const { width: w1, height: h1 } = originalImage.bitmap
    const { width: w2, height: h2 } = captchaImage.bitmap

    console.log(`📏 original.png: ${w1}x${h1}`)
    console.log(`📏 captcha.png: ${w2}x${h2}`)

    // Nếu ảnh không cùng kích thước thì resize captcha.png về kích thước của original.png
    if (w1 !== w2 || h1 !== h2) {
        console.warn('⚠️ Resize captcha.png để khớp với original.png')
        captchaImage.resize(w1, h1)
    }

    // Tạo ảnh kết quả diff
    const diffImage = new Jimp(w1, h1)
    const diffOptions = {
        includeAA: true, // Bao gồm khử răng cưa
        threshold: 0.2   // Ngưỡng nhạy
    }

    // So sánh và tạo ảnh diff
    pixelmatch(
        originalImage.bitmap.data,
        captchaImage.bitmap.data,
        diffImage.bitmap.data,
        w1,
        h1,
        diffOptions
    )

    // Ghi ra file diff
    await diffImage.writeAsync('./diff.png')
    console.log('✅ Đã tạo ảnh diff tại ./diff.png')
}

async function run () {
    const browser = await puppeteer.launch({
        headless: false,
        defaultViewport: null,
        args: ['--start-maximized']
    })
    const page = await browser.newPage()

    await page.goto('https://www.geetest.com/en/demo', { waitUntil: 'networkidle2' })

    await page.waitFor(1000)

    await saveSliderCaptchaImages(page)
    await saveDiffImage()

    let [cx, cy] = await findDiffPosition()

    if (!cx || !cy) {
        console.error('❌ Không tìm được vị trí mảnh ghép')
        return
    }
    console.log('📍 Mảnh ghép cần kéo tới vị trí x:', cx)

    // const sliderHandle = await page.$('.geetest_slider_button')
    const sliderHandle = await page.$('.geetest_slider .geetest_btn')
    if (!sliderHandle) {
        throw new Error('❌ Không tìm thấy phần tử slider `.geetest_btn`')
    }
    const handle = await sliderHandle.boundingBox()

    let xPosition = handle.x + handle.width / 2
    let yPosition = handle.y + handle.height / 2
    await page.mouse.move(xPosition, yPosition)
    await page.mouse.down()

    xPosition = handle.x + cx - handle.width / 2
    yPosition = handle.y + handle.height / 3
    await page.mouse.move(xPosition, yPosition, { steps: 25 })

    await page.waitFor(100)

    const [cxPuzzle, cyPuzzle] = await findPuzzlePosition();
    const offsetX = 2;
    console.log(cxPuzzle);
    xPosition = xPosition + cx - cxPuzzle + offsetX
    yPosition = handle.y + handle.height / 2
    await page.mouse.move(xPosition, yPosition, { steps: 5 })
    await page.mouse.up()

    await page.waitFor(30000)
    // success!

    await fs.unlink('./original.png')
    await fs.unlink('./captcha.png')
    await fs.unlink('./diff.png')
    try {
    await fs.unlink('./puzzle.png')
    } catch (err) {
        if (err.code !== 'ENOENT') {
            throw err;
        }
        console.warn('⚠️ puzzle.png không tồn tại, không cần xoá');
    }
    

    await browser.close()
}

run()
