# Herald Portal

## Academic document rendering

The Academic Document Studio uses Puppeteer to render `public/certificate-generator.html` into high-resolution PNGs. Issued-document PDFs are generated directly with PDFKit and the bundled fonts, so student view, download, and print do not depend on Chrome. Puppeteer's install step downloads its pinned Chrome browser for PNG export; deployment builds must allow that install step to run. If the host provides its own browser, set `PUPPETEER_EXECUTABLE_PATH` (or `CHROME_PATH`) to its executable path. Bundled fonts, school branding, and QR generation are local assets; no external font or QR service is required.
