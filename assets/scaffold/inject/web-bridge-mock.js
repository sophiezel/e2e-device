// @e2e-internal — JSBridge call interception for E2E diagnostics.
// Must be injected into WebView alongside web-request-mock.js.
// Captures native↔H5 bridge calls and stores them in __E2E_REQUEST_MOCK__.bridgeEvents.

(function installE2eBridgeMock() {
	if (window.__E2E_BRIDGE_MOCK_INSTALLED__) return;

	var cfg = window.__E2E_REQUEST_MOCK__;
	if (!cfg) {
		// Mock store not set up yet; retry on a short delay.
		// web-request-mock.js runs first and creates the store.
		return;
	}
	cfg.bridgeEvents = cfg.bridgeEvents || [];

	function recordEvent(direction, method, data) {
		cfg.bridgeEvents.push({
			direction: direction,
			method: method,
			data: data,
			timestamp: Date.now(),
		});
		// Keep buffer bounded
		if (cfg.bridgeEvents.length > 100) cfg.bridgeEvents.shift();
	}

	// ===== Pattern 1: WebViewJavascriptBridge (most common) =====
	// Intercept the setupWVJB and callHandler patterns used by WebViewJavascriptBridge

	var origWVJBSetup = window.setupWebViewJavascriptBridge;
	if (typeof window.WebViewJavascriptBridge !== 'undefined' || typeof origWVJBSetup === 'function') {
		// Override setup to intercept callbacks
		window.setupWebViewJavascriptBridge = function (cb) {
			var wrapper = function (bridge) {
				if (bridge) {
					var origCallHandler = bridge.callHandler;
					bridge.callHandler = function (handlerName, data, responseCb) {
						recordEvent('h5_to_native', handlerName, data);
						return origCallHandler.call(bridge, handlerName, data, function (resp) {
							recordEvent('native_to_h5', handlerName, resp);
							if (typeof responseCb === 'function') responseCb(resp);
						});
					};
					var origRegisterHandler = bridge.registerHandler;
					bridge.registerHandler = function (handlerName, handler) {
						return origRegisterHandler.call(bridge, handlerName, function (data, responseCb) {
							recordEvent('native_to_h5', handlerName, data);
							handler(data, function (resp) {
								recordEvent('h5_to_native', handlerName, resp);
								if (typeof responseCb === 'function') responseCb(resp);
							});
						});
					};
				}
				if (typeof cb === 'function') cb(bridge);
			};
			if (origWVJBSetup) return origWVJBSetup(wrapper);
			return wrapper;
		};
	}

	// ===== Pattern 2: window.postMessage (WebView ↔ H5) =====
	var origPostMessage = window.postMessage.bind(window);
	window.postMessage = function (message, targetOrigin, transfer) {
		try {
			if (message && typeof message === 'object') {
				var method = message.method || message.type || message.action || 'unknown';
				recordEvent('h5_to_native', method, message);
			}
		} catch (e) { /* non-critical */ }
		return origPostMessage(message, targetOrigin, transfer);
	};

	// Listen for incoming messages (native → H5)
	window.addEventListener('message', function (e) {
		try {
			if (e.data && typeof e.data === 'object') {
				var method = e.data.method || e.data.type || e.data.action || 'unknown';
				recordEvent('native_to_h5', method, e.data);
			}
		} catch (ex) { /* non-critical */ }
	});

	// ===== Pattern 3: Common JS bridge globals (React Native, Cordova) =====
	// window.ReactNativeWebView.postMessage
	if (window.ReactNativeWebView && typeof window.ReactNativeWebView.postMessage === 'function') {
		var origRNPostMessage = window.ReactNativeWebView.postMessage.bind(window.ReactNativeWebView);
		window.ReactNativeWebView.postMessage = function (msg) {
			recordEvent('h5_to_native', 'reactNativeWebView.postMessage', msg);
			return origRNPostMessage(msg);
		};
		// Listen for onMessage events from Native
		document.addEventListener('message', function (e) {
			recordEvent('native_to_h5', 'reactNativeWebView.onMessage', (e && e.data));
		});
	}

	// ===== Pattern 4: Android JS Interface (WebView.addJavascriptInterface) =====
	// Generic interception for common Android interface names
	var androidBridgeNames = ['_android', 'Android', 'NativeBridge', 'JSBridge', 'appInterface'];
	var origWindow = window;

	for (var i = 0; i < androidBridgeNames.length; i++) {
		try {
			var name = androidBridgeNames[i];
			var bridgeObj = origWindow[name];
			if (bridgeObj && typeof bridgeObj === 'object') {
				(function (ns, nsName) {
					Object.keys(ns).forEach(function (method) {
						if (typeof ns[method] === 'function') {
							var origFn = ns[method].bind(ns);
							ns[method] = function () {
								var args = Array.prototype.slice.call(arguments);
								recordEvent('h5_to_native', nsName + '.' + method, args.length === 1 ? args[0] : args);
								return origFn.apply(this, args);
							};
						}
					});
				})(bridgeObj, name);
			}
		} catch (e) { /* non-critical */ }
	}

	// ===== Pattern 5: Flutter WebView JavaScriptChannel =====
	if (typeof window.flutter_inappwebview !== 'undefined') {
		var origFlutterCall = window.flutter_inappwebview.callHandler;
		if (typeof origFlutterCall === 'function') {
			window.flutter_inappwebview.callHandler = function (handlerName) {
				var args = Array.prototype.slice.call(arguments, 1);
				recordEvent('h5_to_native', 'flutter.' + handlerName, args);
				return origFlutterCall.apply(this, arguments);
			};
		}
	}

	window.__E2E_BRIDGE_MOCK_INSTALLED__ = true;
})();
