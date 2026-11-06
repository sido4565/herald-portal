# Herald Portal

## Academic document rendering

The Academic Document Studio uses Puppeteer to render `public/certificate-generator.html` into high-resolution PNGs and print-ready PDFs. Puppeteer's install step downloads its pinned Chrome browser; deployment builds must allow that install step to run. If the host provides its own browser, set `PUPPETEER_EXECUTABLE_PATH` (or `CHROME_PATH`) to its executable path. Bundled fonts, school branding, and QR generation are local assets; no external font or QR service is required.
