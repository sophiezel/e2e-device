/**
 * Classify matrix/biz case assert quality for profile filtering.
 * assert-strong: executable expected (toast text / data-e2e / URL / explicit copy)
 * pending-assert: heuristic-only (body exists, blind input, any button)
 */
export type AssertQuality = "assert-strong" | "pending-assert";

export function classifyAssertQuality(input: {
	expectedResult?: string;
	minimalVerification?: string;
	acceptanceCriteria?: string;
	operation?: string;
}): AssertQuality {
	const blob = [
		input.expectedResult,
		input.minimalVerification,
		input.acceptanceCriteria,
	]
		.filter(Boolean)
		.join("\n");

	if (!blob.trim()) return "pending-assert";

	// Strong: toast with concrete copy, data-e2e, URL path, quoted text
	if (
		/data-e2e\s*[=:]\s*[\w-]+/i.test(blob) ||
		/\[data-e2e=["'][\w-]+["']\]/i.test(blob) ||
		/data-testid/i.test(blob)
	) {
		return "assert-strong";
	}
	const hasToastWord = /Toast|toast|提示/.test(blob);
	const hasConcreteCopy =
		/[\u4e00-\u9fff]{2,}/.test(blob) || /["'][^"']{2,}["']/.test(blob);
	if (hasToastWord && hasConcreteCopy) {
		return "assert-strong";
	}
	if (
		/缺少车源号|加载失败|下架失败|提交失败|成功|失败/.test(blob) &&
		/Toast|toast|文案|提示|可见/.test(blob)
	) {
		return "assert-strong";
	}
	if (/URL|url|跳转|导航/.test(blob) && /contain|包含|\/[a-zA-Z0-9_-]+/.test(blob)) {
		return "assert-strong";
	}
	if (/["'\u300c][^"'\u300d]{2,}["'\u300d]/.test(blob) && /(可见|出现|展示|包含|等于)/.test(blob)) {
		return "assert-strong";
	}

	// Weak: only render/body/smoke without concrete assert
	if (/渲染|首屏|展示|车卡|无崩溃|页面存在/.test(blob) && !/Toast|data-e2e|testid/.test(blob)) {
		return "pending-assert";
	}

	if (blob.trim().length < 8) return "pending-assert";

	if (/[\u4e00-\u9fff]{4,}/.test(blob) && /(成功|失败|提示|校验|必填|禁用|跳转)/.test(blob)) {
		return "assert-strong";
	}

	return "pending-assert";
}
