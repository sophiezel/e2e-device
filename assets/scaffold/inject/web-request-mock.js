// @e2e-internal — Mock injection for E2E testing only. Must be excluded from production builds.
/**
 * WebView 内通用 request Mock（fetch + XMLHttpRequest）。
 * 由 enable-web-mock 注入；规则来自 window.__E2E_REQUEST_MOCK__.rules
 * 规则匹配纯粹基于 urlPattern（子串）+ method，无任何业务特判。
 *
 * Hit tracking:
 *   __E2E_REQUEST_MOCK__.hits  — Record<ruleId, count>
 *   __E2E_REQUEST_MOCK__.missed — string[] (URLs not matched by any rule)
 */
(function installE2eRequestMock() {
	if (window.__E2E_REQUEST_MOCK_INSTALLED__) {
		return;
	}

	// Harden mock globals against tampering
	try {
		Object.defineProperty(window, '__E2E_REQUEST_MOCK_INSTALLED__', {
			configurable: false,
			writable: false,
			value: true,
		});
		if (window.__E2E_REQUEST_MOCK__) {
			Object.defineProperty(window, '__E2E_REQUEST_MOCK__', {
				configurable: false,
				writable: false,
				value: window.__E2E_REQUEST_MOCK__,
			});
		}
	} catch {
		// defineProperty may fail in some WebView environments; fallback to direct assignment
		window.__E2E_REQUEST_MOCK_INSTALLED__ = true;
	}

	function ensureTracking(cfg) {
		if (!cfg.hits) cfg.hits = {};
		if (!cfg.missed) cfg.missed = [];
	}

	/**
	 * Generic rule resolver: iterate rules, match by urlPattern (substring) + method.
	 * Returns matched rule or null. Tracks hits and misses.
	 */
	function resolveBody(url, method, rules) {
		var cfg = window.__E2E_REQUEST_MOCK__;
		ensureTracking(cfg);
		for (var i = 0; i < rules.length; i++) {
			var rule = rules[i];
			if (rule.urlPattern && url.indexOf(rule.urlPattern) < 0) {
				continue;
			}
			if (rule.method && rule.method.toUpperCase() !== method) {
				continue;
			}
			// Track hit
			var ruleId = rule.id || rule.urlPattern || ("rule_" + i);
			cfg.hits[ruleId] = (cfg.hits[ruleId] || 0) + 1;
			cfg.lastHit = url;
			// Support optional latency simulation per rule or global
			if (cfg.latency || rule.latency) {
				cfg._pendingLatency = { url: url, method: method, rule: rule, delay: rule.latency || cfg.latency };
			}
			return rule.body;
		}
		// Track miss (deduplicate)
		if (cfg.missed.indexOf(url) < 0 && cfg.missed.length < 100) {
			cfg.missed.push(url);
		}
		return null;
	}

	/** Extract status info from fixture. Supports two formats:
	 *  1. { body: {...}, status: 404, statusText: "Not Found" } — explicit
	 *  2. { ... } — plain body (backward compatible, status 200) */
	function extractFixture(ruleBody) {
		if (ruleBody && typeof ruleBody.body !== 'undefined') {
			return {
				body: ruleBody.body,
				status: ruleBody.status || 200,
				statusText: ruleBody.statusText || (ruleBody.status === 200 ? 'OK' : ''),
			};
		}
		return { body: ruleBody, status: 200, statusText: 'OK' };
	}

	function jsonResponse(body) {
		var fixt = extractFixture(body);
		return new Response(JSON.stringify(fixt.body), {
			status: fixt.status,
			statusText: fixt.statusText,
			headers: { "Content-Type": "application/json;charset=utf-8" },
		});
	}

	function shouldMock() {
		var cfg = window.__E2E_REQUEST_MOCK__;
		return cfg && cfg.enabled && cfg.rules && cfg.rules.length;
	}

	var origFetch = window.fetch.bind(window);
	window.fetch = function (input, init) {
		if (!shouldMock()) {
			return origFetch(input, init);
		}
		var url = typeof input === "string" ? input : input.url;
		var method = (init && init.method) || "GET";
		var body = resolveBody(url, method.toUpperCase(), window.__E2E_REQUEST_MOCK__.rules);
		if (body !== null) {
			return Promise.resolve(jsonResponse(body));
		}
		return origFetch(input, init);
	};

	var XHR = window.XMLHttpRequest;
	function MockXHR() {
		var xhr = new XHR();
		var _url = "";
		var _method = "GET";
		var _mocked = false;
		var _listeners = {};
		var self = this;
		this.readyState = 0;
		this.status = 0;
		this.statusText = "";
		this.responseText = "";
		this.response = "";
		this.responseType = "";
		this.responseURL = "";
		this.withCredentials = false;
		this.timeout = 0;
		this.onload = null;
		this.onreadystatechange = null;
		this.onerror = null;
		this.ontimeout = null;
		this.onabort = null;
		this.onprogress = null;
		this.onloadstart = null;
		this.onloadend = null;

		this.open = function (method, url) {
			_method = (method || "GET").toUpperCase();
			_url = url;
			self.responseURL = url;
		};
		this.setRequestHeader = function () {};
		this.getResponseHeader = function (name) {
			if (_mocked && name && name.toLowerCase() === "content-type") {
				return "application/json;charset=utf-8";
			}
			return xhr.getResponseHeader ? xhr.getResponseHeader(name) : null;
		};
		this.getAllResponseHeaders = function () {
			if (_mocked) {
				return "content-type: application/json;charset=utf-8";
			}
			return xhr.getAllResponseHeaders ? xhr.getAllResponseHeaders() : "";
		};
		this.abort = function () {
			// no-op for mocked requests
		};
		this.addEventListener = function (event, fn) {
			if (!_listeners[event]) _listeners[event] = [];
			_listeners[event].push(fn);
		};
		this.removeEventListener = function (event, fn) {
			if (!_listeners[event]) return;
			_listeners[event] = _listeners[event].filter(function (f) { return f !== fn; });
		};
		this.overrideMimeType = function () {};

		function dispatchEvent(event) {
			var handlers = _listeners[event] || [];
			for (var i = 0; i < handlers.length; i++) {
				try { handlers[i]({ type: event, target: self }); } catch (e) {}
			}
			var onHandler = self["on" + event];
			if (typeof onHandler === "function") {
				try { onHandler.call(self, { type: event, target: self }); } catch (e) {}
			}
		}

		function completeMockResponse(mockBody) {
			_mocked = true;
			var fixt = extractFixture(mockBody);
			var jsonText = JSON.stringify(fixt.body);
			self.readyState = 4;
			self.status = fixt.status;
			self.statusText = fixt.statusText || (fixt.status === 200 ? 'OK' : '');
			self.responseText = jsonText;
			self.response = self.responseType === 'json' ? fixt.body : jsonText;
			self.responseURL = _url;
			dispatchEvent('readystatechange');
			dispatchEvent('load');
			dispatchEvent('loadend');
		}

		this.send = function () {
			if (!shouldMock()) {
				xhr.open(_method, _url);
				xhr.send.apply(xhr, arguments);
				return;
			}
			var body = resolveBody(_url, _method, window.__E2E_REQUEST_MOCK__.rules);
			if (body !== null) {
				// Support optional latency simulation (ms)
				var cfg = window.__E2E_REQUEST_MOCK__;
				if (cfg._pendingLatency) {
					var delay = cfg._pendingLatency.delay || 0;
					cfg._pendingLatency = null;
					if (delay > 0) {
						setTimeout(function () { completeMockResponse(body); }, delay);
						return;
					}
				}
				completeMockResponse(body);
				return;
			}
			xhr.open(_method, _url);
			xhr.send.apply(xhr, arguments);
		};
	}
	window.XMLHttpRequest = MockXHR;

	// ===== JS Error Capture for E2E Diagnostics =====
	// Collects console.error, unhandled rejections, and runtime errors
	// into __E2E_REQUEST_MOCK__.jsErrors for retrieval by test framework.
	(function installJsErrorCapture() {
		var cfg = window.__E2E_REQUEST_MOCK__;
		if (!cfg) return;
		cfg.jsErrors = cfg.jsErrors || [];

		function pushError(msg, source, line, col) {
			cfg.jsErrors.push({
				message: String(msg || '').substring(0, 500),
				source: String(source || ''),
				lineno: Number(line) || 0,
				colno: Number(col) || 0,
				timestamp: Date.now(),
			});
			// Keep buffer bounded
			if (cfg.jsErrors.length > 50) cfg.jsErrors.shift();
		}

		// Capture uncaught runtime errors
		window.addEventListener('error', function (e) {
			pushError(e.message, e.filename, e.lineno, e.colno);
		});

		// Capture unhandled Promise rejections
		window.addEventListener('unhandledrejection', function (e) {
			var reason = e.reason;
			var msg = 'UnhandledRejection: ';
			if (reason && typeof reason.message === 'string') {
				msg += reason.message;
			} else {
				msg += String(reason);
			}
			pushError(msg, '', 0, 0);
		});

		// Capture console.error calls (non-fatal diagnostics)
		var origConsoleError = console.error.bind(console);
		console.error = function () {
			var args = Array.prototype.slice.call(arguments);
			pushError('[console.error] ' + args.map(function (a) {
				return typeof a === 'object' ? JSON.stringify(a) : String(a);
			}).join(' '), '', 0, 0);
			return origConsoleError.apply(console, arguments);
		};
	})();
})();
