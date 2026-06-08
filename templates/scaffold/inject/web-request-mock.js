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
			return rule.body;
		}
		// Track miss (deduplicate)
		if (cfg.missed.indexOf(url) < 0 && cfg.missed.length < 100) {
			cfg.missed.push(url);
		}
		return null;
	}

	function jsonResponse(body) {
		return new Response(JSON.stringify(body), {
			status: 200,
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

		this.send = function () {
			if (!shouldMock()) {
				xhr.open(_method, _url);
				xhr.send.apply(xhr, arguments);
				return;
			}
			var body = resolveBody(_url, _method, window.__E2E_REQUEST_MOCK__.rules);
			if (body !== null) {
				_mocked = true;
				var jsonText = JSON.stringify(body);
				self.readyState = 4;
				self.status = 200;
				self.statusText = "OK";
				self.responseText = jsonText;
				self.response = self.responseType === "json" ? body : jsonText;
				self.responseURL = _url;
				dispatchEvent("readystatechange");
				dispatchEvent("load");
				dispatchEvent("loadend");
				return;
			}
			xhr.open(_method, _url);
			xhr.send.apply(xhr, arguments);
		};
	}
	window.XMLHttpRequest = MockXHR;
})();
