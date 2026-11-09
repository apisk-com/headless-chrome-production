# Run Puppeteer and Playwright in Docker

Dockerfiles for a small Puppeteer service and a small Playwright service, with
a health check, the Chrome sandbox on, a non-root user and an init process.
`test.sh` builds four images, breaks them on purpose and records each error.
The tutorial explains each file and each error:
[Run Puppeteer and Playwright in Docker Without Crashes](https://apisk.com/blog/puppeteer-playwright-docker/).
