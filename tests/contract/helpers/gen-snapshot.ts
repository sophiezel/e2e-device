/**
 * Test helper: invoke spec generators and print JSON snapshot of generated content.
 * Invoked by tests/contract/auto-generate-selectors.test.mjs via ts-node.
 *
 * This is a TEST-ONLY helper — not part of the Skill runtime.
 */
import { generateSpecFromMatrix, generateListCases, generateChaosSpec } from "../../../assets/scaffold/orchestration/auto-generate-cases";
import type { MatrixCase } from "../../../assets/scaffold/orchestration/discover-matrix-doc";

const domain = "demoDomain";

const matrixCases: MatrixCase[] = [
	{
		caseId: "C01",
		source: "matrix",
		pageModule: domain,
		acceptanceCriteria: "toast",
		preconditions: "无 clueId",
		operation: "打开页面",
		expectedResult: "Toast 提示缺少车源号",
		executionMethod: "auto",
		minimalVerification: "可见 Toast 缺少车源号",
	},
	{
		caseId: "C02",
		source: "matrix",
		pageModule: "demoForm",
		acceptanceCriteria: "渲染",
		preconditions: "已进页",
		operation: "打开表单",
		expectedResult: "页面渲染",
		executionMethod: "auto",
		minimalVerification: "首屏展示",
	},
	{
		caseId: "C03",
		source: "matrix",
		pageModule: "demoForm",
		acceptanceCriteria: "提交",
		preconditions: "已填表",
		operation: "点提交",
		expectedResult: "Toast 提交失败",
		executionMethod: "auto",
		minimalVerification: "可见 Toast 提交失败",
	},
	{
		caseId: "C04",
		source: "matrix",
		pageModule: domain,
		acceptanceCriteria: "跳转",
		preconditions: "已选车",
		operation: "点击下一步",
		expectedResult: "跳转到表单页",
		executionMethod: "auto",
		minimalVerification: "导航成功",
	},
	{
		caseId: "C05",
		source: "matrix",
		pageModule: domain,
		acceptanceCriteria: "选车",
		preconditions: "列表已加载",
		operation: "选择车源",
		expectedResult: "展示车卡",
		executionMethod: "auto",
		minimalVerification: "首屏展示",
	},
];

const specs = [
	...matrixCases.map((m) => generateSpecFromMatrix(m, domain)),
	...generateListCases(domain, "demoForm"),
	generateChaosSpec(`${domain}.chaos.api-500`, domain, "API 500 错误"),
	generateChaosSpec(`${domain}.chaos.network-offline`, domain, "网络离线"),
];

const output = specs.map((s) => ({
	id: s.id,
	source: s.source,
	content: s.content,
}));

process.stdout.write(JSON.stringify(output));
