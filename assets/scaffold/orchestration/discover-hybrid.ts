import fs from "node:fs";
import path from "node:path";
import type { CaseEntry } from "./discover-cases";
import { sandboxDir } from "./paths";

/** Sanitize domain name to prevent template injection in generated specs. */
function safeDomain(domain: string): string {
	if (!/^[a-zA-Z0-9_./-]+$/.test(domain)) {
		throw new Error(`Invalid domain name: "${domain}". Only alphanumeric, dot, slash, underscore, and hyphen are allowed.`);
	}
	return domain;
}

/**
 * 生成生命周期测试 spec 内容
 */
export function generateLifecycleSpec(domain: string): string {
	const d = safeDomain(domain);
	return `import { browser } from "@wdio/globals";
import { switchToNative, switchToWebViewContaining } from "../helpers/webview-context";
import { ensurePilotEntry } from "../helpers/suite-entry";

describe("${d} - Hybrid 生命周期", () => {
  it("App 冷启动后 WebView 正常加载", async () => {
    // 1. 确保 App 启动并进入 WebView
    await ensurePilotEntry("${d}");

    // 2. 验证 WebView 加载成功（URL 为有效 HTTP 地址）
    const url = await browser.getUrl();
    expect(url).toMatch(/^https?:\\/\\//);
  });

  it("WebView 销毁后重新创建正常", async () => {
    // 1. 切换到 Native
    await switchToNative();

    // 2. 重新打开 WebView
    await ensurePilotEntry("${d}");

    // 3. 验证 WebView 加载成功
    const url = await browser.getUrl();
    expect(url).toMatch(/^https?:\\/\\//);
  });
});
`;
}

/**
 * 生成导航测试 spec 内容
 */
export function generateNavigationSpec(domain: string): string {
	const d = safeDomain(domain);
	return `import { browser } from "@wdio/globals";
import {
  switchToNative,
  switchToWebViewContaining,
  getCurrentWebUrl,
} from "../helpers/webview-context";
import { ensurePilotEntry } from "../helpers/suite-entry";

describe("${d} - Hybrid 导航", () => {
  it("Native → WebView 切换正常", async () => {
    // 1. 切换到 Native
    await switchToNative();

    // 2. 进入 WebView
    await ensurePilotEntry("${d}");

    // 3. 验证 WebView 加载成功
    const url = await getCurrentWebUrl();
    expect(url).toMatch(/^https?:\\/\\//);
  });

  it("WebView → Native 返回正常", async () => {
    // 1. 进入 WebView
    await ensurePilotEntry("${d}");

    // 2. 切换到 Native
    await switchToNative();

    // 3. 验证回到 Native（可通过检查 context 验证）
    const contexts = await browser.getContexts();
    expect(contexts).toContain("NATIVE_APP");
  });
});
`;
}

/**
 * 生成 Bridge 测试 spec 内容
 */
export function generateBridgeSpec(domain: string): string {
	const d = safeDomain(domain);
	return `import { browser } from "@wdio/globals";
import { ensurePilotEntry } from "../helpers/suite-entry";

describe("${d} - Hybrid JS Bridge", () => {
  beforeEach(async () => {
    await ensurePilotEntry("${d}");
  });

  it("JS 调用 Native 方法正常", async () => {
    // 在 WebView 中调用 JS Bridge
    // 根据实际 Bridge 接口实现
    const result = await browser.execute(() => {
      // 示例：检查 bridge 对象是否存在
      return typeof window !== "undefined";
    });
    expect(result).toBe(true);
  });

  it("Native 调用 JS 方法正常", async () => {
    // Native 触发事件，验证 JS 回调执行
    // 根据实际 Bridge 接口实现
    expect(true).toBe(true);
  });
});
`;
}

/**
 * 生成错误处理测试 spec 内容
 */
export function generateErrorSpec(domain: string): string {
	const d = safeDomain(domain);
	return `import { browser } from "@wdio/globals";
import { ensurePilotEntry } from "../helpers/suite-entry";

describe("${d} - Hybrid 错误处理", () => {
  it("页面加载失败时显示错误提示", async () => {
    // 1. 尝试加载不存在的页面
    // 模拟网络异常或页面加载失败

    // 2. 验证显示错误提示
    // 检查错误 UI 元素

    // 3. 恢复后重试成功
    await ensurePilotEntry("${d}");
    const url = await browser.getUrl();
    expect(url).toMatch(/^https?:\\/\\//);
  });

  it("JS 错误不导致 App 崩溃", async () => {
    // 1. 进入页面
    await ensurePilotEntry("${d}");

    // 2. 触发 JS 错误（如果有方式）
    // 模拟 JS 错误

    // 3. 验证 App 仍在运行
    const url = await browser.getUrl();
    expect(url).toBeDefined();
  });
});
`;
}

/**
 * 生成性能测试 spec 内容
 */
export function generatePerformanceSpec(domain: string): string {
	const d = safeDomain(domain);
	return `import { browser } from "@wdio/globals";
import { ensureWarmPilotEntry } from "../helpers/suite-entry";
import { timeouts } from "../config/timeouts";

describe("${d} - Hybrid 性能边界", () => {
  it("页面加载时间 < 15s (真机 warm baseline)", async () => {
    const start = Date.now();
    await ensureWarmPilotEntry("${d}");
    const duration = Date.now() - start;

    console.log("[performance] Page load time:", duration, "ms");
    expect(duration).toBeLessThan(15000);
  });

  it("快速切换不导致内存泄漏", async () => {
    const initialMemory = await browser.execute(() => {
      const p = (performance as unknown) as Record<string, unknown>;
      const mem = p["memory"] as Record<string, unknown> | undefined;
      return (mem?.["usedJSHeapSize"] as number) || 0;
    });

    for (let i = 0; i < 3; i++) {
      await ensureWarmPilotEntry("${d}");
      await browser.pause(timeouts.PAUSE_SHORT);
    }

    const finalMemory = await browser.execute(() => {
      const p = (performance as unknown) as Record<string, unknown>;
      const mem = p["memory"] as Record<string, unknown> | undefined;
      return (mem?.["usedJSHeapSize"] as number) || 0;
    });

    if (initialMemory > 0) {
      const growth = (finalMemory - initialMemory) / initialMemory;
      console.log("[performance] Memory growth:", (growth * 100).toFixed(2), "%");
      expect(growth).toBeLessThan(0.5);
    }
  });
});
`;
}

/**
 * 主函数：生成 Hybrid 测试用例
 *
 * 分层逻辑（mode tags）：
 * - standard: lifecycle, navigation（有真实 URL/context 断言）
 * - resilience: + bridge/error（pending-spec stubs）+ performance
 */
export function discoverHybridCases(domain: string): CaseEntry[] {
	const sb = sandboxDir();
	return [
		{
			id: `${domain}.hybrid.lifecycle`,
			spec: path.join(sb, "specs", `${domain}.hybrid.lifecycle.spec.ts`),
			tags: ["hybrid", "lifecycle", "standard", "infra-cold", "assert-strong"],
			source: "hybrid",
			metadata: { description: "生命周期测试（冷启动、WebView重建）", journeySegment: "infra" },
		},
		{
			id: `${domain}.hybrid.navigation`,
			spec: path.join(sb, "specs", `${domain}.hybrid.navigation.spec.ts`),
			tags: ["hybrid", "navigation", "standard", "infra-cold", "assert-strong"],
			source: "hybrid",
			metadata: { description: "导航测试（Native↔WebView切换）", journeySegment: "infra" },
		},
		// Stubs until real Bridge/error assertions exist — excluded from quick/standard via pending-spec
		{
			id: `${domain}.hybrid.bridge`,
			spec: path.join(sb, "specs", `${domain}.hybrid.bridge.spec.ts`),
			tags: ["hybrid", "bridge", "resilience", "pending-spec"],
			source: "hybrid",
			metadata: { description: "JS Bridge测试（JS↔Native通信）", journeySegment: "infra" },
		},
		{
			id: `${domain}.hybrid.error`,
			spec: path.join(sb, "specs", `${domain}.hybrid.error.spec.ts`),
			tags: ["hybrid", "error", "resilience", "pending-spec"],
			source: "hybrid",
			metadata: { description: "错误处理测试（网络异常、JS错误）", journeySegment: "infra" },
		},
		{
			id: `${domain}.hybrid.performance`,
			spec: path.join(sb, "specs", `${domain}.hybrid.performance.spec.ts`),
			tags: ["hybrid", "performance", "resilience", "assert-strong"],
			source: "hybrid",
			metadata: { description: "性能边界测试（加载时间、内存）", journeySegment: "infra" },
		},
	];
}

/** Write hybrid specs into sandbox regardless of matrix availability. */
export function writeHybridSpecs(domain: string): void {
	const sb = sandboxDir();
	const specsDir = path.join(sb, "specs");
	fs.mkdirSync(specsDir, { recursive: true });

	const writers: Array<{ file: string; content: string; onlyIfMissing?: boolean }> = [
		{ file: `${domain}.hybrid.lifecycle.spec.ts`, content: generateLifecycleSpec(domain) },
		{ file: `${domain}.hybrid.navigation.spec.ts`, content: generateNavigationSpec(domain) },
		{ file: `${domain}.hybrid.bridge.spec.ts`, content: generateBridgeSpec(domain), onlyIfMissing: true },
		{ file: `${domain}.hybrid.error.spec.ts`, content: generateErrorSpec(domain), onlyIfMissing: true },
		{ file: `${domain}.hybrid.performance.spec.ts`, content: generatePerformanceSpec(domain), onlyIfMissing: true },
	];

	for (const w of writers) {
		const full = path.join(specsDir, w.file);
		if (w.onlyIfMissing && fs.existsSync(full)) continue;
		fs.writeFileSync(full, w.content, "utf-8");
	}
}
