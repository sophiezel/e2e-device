/**
 * WebView 内通用 request Mock（fetch + XMLHttpRequest）。
 * 由 enable-web-mock 注入；规则来自 window.__E2E_REQUEST_MOCK__.rules
 */
(function installE2eRequestMock() {
	if (window.__E2E_REQUEST_MOCK_INSTALLED__) {
		return;
	}
	window.__E2E_REQUEST_MOCK_INSTALLED__ = true;

	function pickListBody(url, rules) {
		if (url.indexOf("tableType=audited") >= 0 || url.indexOf("tableType%3Daudited") >= 0) {
			return rules.find(function (r) {
				return r.id === "list.audited";
			});
		}
		if (url.indexOf("tableType=un_audit") >= 0 || url.indexOf("tableType%3Dun_audit") >= 0) {
			return rules.find(function (r) {
				return r.id === "list.un_audit";
			});
		}
		return undefined;
	}

	function pickGetByIdBody(url, rules) {
		var m = url.match(/[?&]id=([^&]+)/);
		var id = m && m[1] ? decodeURIComponent(m[1]) : "";
		if (id === "999") {
			return (
				rules.find(function (r) {
					return r.id === "getById.999";
				}) || undefined
			);
		}
		return (
			rules.find(function (r) {
				return r.id === "getById.101";
			}) || undefined
		);
	}

	function resolveBody(url, method, rules) {
		for (var i = 0; i < rules.length; i++) {
			var rule = rules[i];
			if (url.indexOf(rule.urlPattern) < 0) {
				continue;
			}
			if (rule.method && rule.method !== method) {
				continue;
			}
			if (rule.id.indexOf("list.") === 0) {
				var listRule = pickListBody(url, rules) || rule;
				return listRule.body;
			}
			if (rule.id.indexOf("getById.") === 0) {
				var idRule = pickGetByIdBody(url, rules) || rule;
				return idRule.body;
			}
			if (rule.id.indexOf("submit.") === 0) {
				if (
					url.indexOf("id=999") >= 0 ||
					url.indexOf('"id":999') >= 0 ||
					url.indexOf('"id":"999"') >= 0
				) {
					var err = rules.find(function (r) {
						return r.id === "submit.error";
					});
					return err ? err.body : rule.body;
				}
				var ok = rules.find(function (r) {
					return r.id === "submit.success";
				});
				return ok ? ok.body : rule.body;
			}
			return rule.body;
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
		if (body) {
			window.__E2E_REQUEST_MOCK__.lastHit = url;
			return Promise.resolve(jsonResponse(body));
		}
		return origFetch(input, init);
	};

	var XHR = window.XMLHttpRequest;
	function MockXHR() {
		var xhr = new XHR();
		var _url = "";
		var _method = "GET";
		var self = this;
		this.readyState = 0;
		this.status = 0;
		this.responseText = "";
		this.onload = null;

		this.open = function (method, url) {
			_method = (method || "GET").toUpperCase();
			_url = url;
		};
		this.setRequestHeader = function () {};
		this.send = function () {
			if (!shouldMock()) {
				return xhr.open(_method, _url), xhr.send.apply(xhr, arguments);
			}
			var body = resolveBody(_url, _method, window.__E2E_REQUEST_MOCK__.rules);
			if (body) {
				window.__E2E_REQUEST_MOCK__.lastHit = _url;
				self.readyState = 4;
				self.status = 200;
				self.responseText = JSON.stringify(body);
				if (typeof self.onload === "function") {
					self.onload();
				}
				return;
			}
			xhr.open(_method, _url);
			xhr.send.apply(xhr, arguments);
		};
	}
	window.XMLHttpRequest = MockXHR;
})();
