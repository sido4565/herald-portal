# Herald Portal

## Academic document rendering

The Academic Document Studio uses Puppeteer Core to render `public/certificate-generator.html` into high-resolution PNGs and print-ready PDFs. Install Chrome/Chromium in the deployment image and set `PUPPETEER_EXECUTABLE_PATH` (or `CHROME_PATH`) to its executable path. Bundled fonts, school branding, and QR generation are local assets; no external font or QR service is required.
