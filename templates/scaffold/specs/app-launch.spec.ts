import { browser } from "@wdio/globals";

describe("App Launch", () => {
	it("should launch app and navigate to target page", async () => {
		// Wait for the app to be ready
		await browser.pause(5000);

		// Get the current context to verify we're in a WebView
		let contexts = await browser.getContexts();
		console.log("[app-launch] Initial contexts:", contexts);

		// If only NATIVE_APP, wait for WebView to appear
		if (contexts.length === 1 && contexts[0] === "NATIVE_APP") {
			console.log("[app-launch] Only NATIVE_APP, waiting for WebView...");
			await browser.waitUntil(
				async () => {
					const ctx = await browser.getContexts();
					return ctx.some((c) => typeof c === "string" && c.includes("WEBVIEW"));
				},
				{ timeout: 30000, timeoutMsg: "WebView did not appear within 30s" },
			);
			contexts = await browser.getContexts();
			console.log("[app-launch] Updated contexts:", contexts);
		}

		// Switch to WebView context if available
		const webviewContext = contexts.find((c) =>
			typeof c === "string" ? c.includes("WEBVIEW") : false,
		);
		if (webviewContext && typeof webviewContext === "string") {
			await browser.switchContext(webviewContext);
			console.log("[app-launch] Switched to WebView context:", webviewContext);

			// Wait for the page to load
			await browser.waitUntil(
				async () => {
					try {
						const url = await browser.getUrl();
						return url.includes("/v2");
					} catch {
						return false;
					}
				},
				{ timeout: 15000, timeoutMsg: "Page did not load within 15s" },
			);

			const currentUrl = await browser.getUrl();
			console.log("[app-launch] Current URL:", currentUrl);

			// Verify we're on the right page
			expect(currentUrl).toContain("/v2");
		} else {
			console.log("[app-launch] No WebView context found, test passed in native mode");
		}

		console.log("[app-launch] App launched successfully");
	});
});
