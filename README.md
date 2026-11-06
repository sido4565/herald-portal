# Herald Portal

## Academic document rendering

The Academic Document Studio uses its local `html-to-image` bundle to export the certificate element as a high-resolution PNG. Issued-document PDFs are generated directly with PDFKit and the bundled fonts, so student view, download, and print do not depend on Chrome. Puppeteer remains available for server-side PNG exports; its install step downloads a pinned Chrome browser, so deployment builds must allow that step to run. If the host provides its own browser, set `PUPPETEER_EXECUTABLE_PATH` (or `CHROME_PATH`) to its executable path. Bundled fonts, school branding, and QR generation are local assets; no external font or QR service is required.
