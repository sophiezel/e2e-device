/**
 * Android SDK environment setup
 */

export function applyAndroidSdkEnv(): void {
	const sdkRoot =
		process.env.ANDROID_HOME ||
		process.env.ANDROID_SDK_ROOT ||
		"";
	if (sdkRoot) {
		process.env.ANDROID_HOME = sdkRoot;
		process.env.ANDROID_SDK_ROOT = sdkRoot;
	}
}
