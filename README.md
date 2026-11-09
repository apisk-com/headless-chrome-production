# Headless Chrome in production

Working code that runs headless Chrome in production: Docker images, AWS Lambda, SSRF protection, browser pools and queues, API keys and rate limits. Each folder is one complete example: one language and tool, or one
problem. The [APISK tutorials](https://apisk.com/blog/) explain the code step
by step.

## Examples

| Folder | Language and tools | What it does | Tutorial |
|---|---|---|---|
| [docker](docker/) | Docker, Puppeteer, Playwright | Docker images for Puppeteer and Playwright, and the errors they prevent | [Run Puppeteer and Playwright in Docker Without Crashes](https://apisk.com/blog/puppeteer-playwright-docker/), 5 January 2027 |

Each folder runs on its own: open its `README.md` for the commands.

## Add an example

Examples for other languages and tools are welcome. Put each one in its own
folder. Name the folder `<language>-<tool>`, for example
`java-openhtmltopdf`, or name it after the problem that it solves. Add a
`test.sh` file that installs what the example needs on Ubuntu 24.04 and runs
its tests. The test workflow runs `test.sh` for each folder that a push or a
pull request changes.

## License

MIT. See [LICENSE](LICENSE).
