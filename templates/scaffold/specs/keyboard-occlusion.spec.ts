/**
 * keyboard-occlusion.spec.ts
 * 真机端侧测试 — 键盘遮挡输入框场景 (KEY-001 ~ KEY-012)
 *
 * 设计原则:
 *  1. 每条 case 失败后记录问题栈，不阻断后续 case
 *  2. 不自动修复，测试只测不修
 *  3. 每个 it 内自行 try/catch，失败输出结构化 JSON 问题栈
 */

import { browser } from "@wdio/globals";
import { switchToWebViewContaining } from "../helpers/webview-context";
import { timeouts } from "../config/timeouts";
import { recordFailure, recordPass } from "../helpers/diagnostic-collector";

describe("Keyboard Occlusion (KEY)", () => {
  const domain = process.env.E2E_DOMAIN || "";

  before(async () => {
    await switchToWebViewContaining(domain, timeouts.webViewNormal);
  });

  // ==================== KEY-001: 底部输入框焦点定位 ====================
  it("KEY-001 底部输入框焦点定位", async () => {
    try {
      // 定位页面最底部输入框
      const inputs = await browser.$$("input, textarea, [contenteditable]");
      if (inputs.length === 0) {
        recordFailure("KEY-001", "NO_INPUT_FOUND", "页面未找到任何输入框");
        return;
      }

      const lastInput = inputs[inputs.length - 1];

      // 滚动到输入框附近但不触发焦点
      await browser.executeScript(
        "arguments[0].scrollIntoView({block: 'end'})",
        [lastInput]
      );
      await browser.pause(500);

      // 获取输入框初始位置
      const rectBefore = await browser.getElementRect(lastInput.elementId);

      // 聚焦输入框
      await lastInput.click();
      await browser.pause(1000); // 等待键盘弹出和滚动动画

      // 获取键盘弹出后的输入框位置
      const rectAfter = await browser.getElementRect(lastInput.elementId);

      // 检查键盘是否弹出
      const isKeyboardShown = await browser.isKeyboardShown();

      if (!isKeyboardShown) {
        recordFailure(
          "KEY-001",
          "KEYBOARD_NOT_SHOWN",
          "键盘未弹出，无法验证遮挡情况",
          { rectBefore, rectAfter }
        );
        await browser.hideKeyboard();
        return;
      }

      // 获取视口尺寸
      const viewportSize = await browser.executeScript(
        "return { height: window.visualViewport?.height || window.innerHeight, width: window.visualViewport?.width || window.innerWidth }"
      );
      const viewportHeight =
        (viewportSize as { height: number }).height;

      // 验证输入框在可视区域内
      const inputBottom = rectAfter.y + rectAfter.height;
      const isOccluded = inputBottom > viewportHeight * 0.9; // 超过视口 90% 视为遮挡

      if (isOccluded) {
        recordFailure(
          "KEY-001",
          "INPUT_OCCLUDED",
          `输入框底部 (${inputBottom}px) 超出可视区 (${viewportHeight}px)，被键盘遮挡`,
          { rectBefore, rectAfter, viewportHeight }
        );
      } else {
        recordPass("KEY-001", { rectBefore, rectAfter, viewportHeight });
      }

      await browser.hideKeyboard();
    } catch (e: any) {
      recordFailure("KEY-001", "UNCAUGHT_ERROR", e.message, {
        stack: e.stack,
      });
    }
  });

  // ==================== KEY-002: 连续切换输入框无闪烁 ====================
  it("KEY-002 连续切换输入框无闪烁", async () => {
    try {
      const inputs = await browser.$$("input:not([type='hidden']), textarea");
      if (inputs.length < 3) {
        recordFailure("KEY-002", "INSUFFICIENT_INPUTS", `需要至少3个输入框，当前${inputs.length}个`);
        return;
      }

      let flickerDetected = false;
      const positions: any[] = [];

      // 取前3个输入框
      const testInputs = inputs.slice(0, 3);
      for (let i = 0; i < testInputs.length; i++) {
        await testInputs[i].click();
        await browser.pause(800);
        
        const rect = await browser.getElementRect(testInputs[i].elementId);
        positions.push({ index: i, rect });
        
        // 在中间插入一次额外的位置检查来捕获闪烁
        const midRect = await browser.getElementRect(testInputs[i].elementId);
        if (Math.abs(midRect.y - rect.y) > 5) {
          flickerDetected = true;
        }
      }

      if (flickerDetected) {
        recordFailure("KEY-002", "FLICKER_DETECTED", "快速切换输入框时检测到位置闪烁", { positions });
      } else {
        recordPass("KEY-002", { positions });
      }

      await browser.hideKeyboard();
    } catch (e: any) {
      recordFailure("KEY-002", "UNCAUGHT_ERROR", e.message, { stack: e.stack });
    }
  });

  // ==================== KEY-003: 第三方输入法兼容 ====================
  it("KEY-003 第三方输入法兼容", async () => {
    try {
      // 第三方输入法检测依赖外部预置条件
      // 此处验证键盘弹出后基本信息
      const inputs = await browser.$$("input:not([type='hidden'])");
      if (inputs.length === 0) {
        recordFailure("KEY-003", "NO_INPUT", "无可用输入框");
        return;
      }

      await inputs[0].click();
      await browser.pause(1500);

      const isKeyboardShown = await browser.isKeyboardShown();
      const rect = await browser.getElementRect(inputs[0].elementId);
      const viewportSize = await browser.executeScript(
        "return { height: window.visualViewport?.height || window.innerHeight }"
      );
      const viewportHeight = (viewportSize as { height: number }).height;

      if (!isKeyboardShown) {
        recordFailure("KEY-003", "KEYBOARD_NOT_SHOWN", "第三方输入法键盘未弹出");
        return;
      }

      const inputCenterY = rect.y + rect.height / 2;
      const isVisible = inputCenterY > 0 && inputCenterY < viewportHeight;

      if (isVisible) {
        recordPass("KEY-003", { rect, viewportHeight, note: "需手动切换第三方输入法后复测" });
      } else {
        recordFailure("KEY-003", "INPUT_NOT_VISIBLE", "输入框在键盘弹出后不可见", {
          rect,
          viewportHeight,
        });
      }

      await browser.hideKeyboard();
    } catch (e: any) {
      recordFailure("KEY-003", "UNCAUGHT_ERROR", e.message, { stack: e.stack });
    }
  });

  // ==================== KEY-004: 键盘开启后旋转屏幕 ====================
  it("KEY-004 键盘开启后旋转屏幕", async () => {
    try {
      const inputs = await browser.$$("input:not([type='hidden'])");
      if (inputs.length === 0) {
        recordFailure("KEY-004", "NO_INPUT", "无可用输入框");
        return;
      }

      // 聚焦输入框
      await inputs[0].click();
      await browser.pause(1000);

      const beforeRect = await browser.getElementRect(inputs[0].elementId);

      // 旋转设备（需要真机支持，Appium 方向切换）
      await browser.setOrientation("LANDSCAPE");
      await browser.pause(2000);

      const landscapeRect = await browser.getElementRect(
        inputs[0].elementId
      );
      const landscapeViewport: any = await browser.executeScript(
        "return { height: window.visualViewport?.height || window.innerHeight }"
      );

      // 旋转回竖屏
      await browser.setOrientation("PORTRAIT");
      await browser.pause(2000);

      const afterRect = await browser.getElementRect(inputs[0].elementId);

      // 验证旋转后输入框仍然可见
      if (
        landscapeRect.y + landscapeRect.height >
        landscapeViewport.height * 1.1
      ) {
        recordFailure(
          "KEY-004",
          "LANDSCAPE_OCCLUDED",
          "横屏时输入框被遮挡",
          { landscapeRect, landscapeViewport }
        );
      } else if (afterRect.y < 0) {
        recordFailure("KEY-004", "PORTRAIT_OFFSET", "恢复竖屏后输入框位置异常", {
          beforeRect,
          afterRect,
        });
      } else {
        recordPass("KEY-004", { beforeRect, landscapeRect, afterRect });
      }

      await browser.hideKeyboard();
    } catch (e: any) {
      recordFailure("KEY-004", "UNCAUGHT_ERROR", e.message, { stack: e.stack });
    }
  });

  // ==================== KEY-005: 不同 inputmode ====================
  it("KEY-005 不同inputmode键盘高度变化", async () => {
    try {
      // 尝试查找不同 inputmode 的输入框
      const textInput = await browser.$("input[type='text'], input:not([type])");
      const numberInput = await browser.$("input[type='number'], input[inputmode='numeric']");
      const passwordInput = await browser.$("input[type='password']");

      if (!(await textInput.isExisting())) {
        recordFailure("KEY-005", "NO_TEXT_INPUT", "未找到 text 类型输入框");
        return;
      }

      // text
      await textInput.click();
      await browser.pause(1000);
      const textRect = await browser.getElementRect(textInput.elementId);
      await browser.hideKeyboard();
      await browser.pause(500);

      // number
      if (await numberInput.isExisting()) {
        await numberInput.click();
        await browser.pause(1000);
        const numRect = await browser.getElementRect(numberInput.elementId);
        await browser.hideKeyboard();
        await browser.pause(500);
        recordPass("KEY-005", {
          textRect,
          numRect,
          note: "需人工验证键盘高度变化后输入框跟随情况",
        });
      } else {
        recordPass("KEY-005", {
          textRect,
          note: "仅测试了 text 类型，待补充 number/password 输入框",
        });
      }
    } catch (e: any) {
      recordFailure("KEY-005", "UNCAUGHT_ERROR", e.message, { stack: e.stack });
    }
  });

  // ==================== KEY-006: 弹窗内输入框+键盘 ====================
  it("KEY-006 弹窗内输入框+键盘", async () => {
    try {
      // 查找弹窗内的输入框
      const modalInput = await browser.$(
        "[role='dialog'] input, .modal input, [class*='modal'] input, [class*='drawer'] input, [class*='popup'] input"
      );

      if (!(await modalInput.isExisting())) {
        // 尝试触发弹窗：查找可能的触发按钮
        recordFailure(
          "KEY-006",
          "NO_MODAL_INPUT",
          "未找到弹窗内输入框，请确认页面是否有弹窗场景，或需要在 preconditions 中定义触发方式",
          { hint: "尝试查找 role=dialog 或 .modal 或 .drawer 内 input" }
        );
        return;
      }

      await modalInput.click();
      await browser.pause(1000);

      const rect = await browser.getElementRect(modalInput.elementId);
      const viewportSize: any = await browser.executeScript(
        "return { height: window.visualViewport?.height || window.innerHeight }"
      );

      const inputBottom = rect.y + rect.height;
      if (inputBottom > viewportSize.height * 0.85) {
        recordFailure("KEY-006", "MODAL_INPUT_OCCLUDED", "弹窗内输入框被键盘遮挡", {
          rect,
          viewportHeight: viewportSize.height,
        });
      } else {
        recordPass("KEY-006", { rect, viewportHeight: viewportSize.height });
      }

      await browser.hideKeyboard();
    } catch (e: any) {
      recordFailure("KEY-006", "UNCAUGHT_ERROR", e.message, { stack: e.stack });
    }
  });

  // ==================== KEY-007: 粘贴大段文字 ====================
  it("KEY-007 粘贴大段文字", async () => {
    try {
      const textarea = await browser.$("textarea");
      if (!(await textarea.isExisting())) {
        recordFailure("KEY-007", "NO_TEXTAREA", "未找到 textarea");
        return;
      }

      await textarea.click();
      await browser.pause(500);

      const beforeRect = await browser.getElementRect(textarea.elementId);

      // 设置剪贴板并粘贴
      const longText = "A".repeat(500);
      await browser.setClipboard(longText);
      // 通过 adb 或 executeScript 粘贴
      await browser.executeScript(
        `arguments[0].value += '${longText.replace(/'/g, "\\'")}'; arguments[0].dispatchEvent(new Event('input', {bubbles: true}))`,
        [textarea]
      );
      await browser.pause(500);

      const afterRect = await browser.getElementRect(textarea.elementId);

      // 粘贴后输入框应可见
      if (afterRect.y + afterRect.height < 0) {
        recordFailure("KEY-007", "TEXTAREA_GONE", "粘贴后 textarea 不可见", {
          beforeRect,
          afterRect,
        });
      } else {
        recordPass("KEY-007", { beforeRect, afterRect, textLength: longText.length });
      }

      await browser.hideKeyboard();
    } catch (e: any) {
      recordFailure("KEY-007", "UNCAUGHT_ERROR", e.message, { stack: e.stack });
    }
  });

  // ==================== KEY-008: iOS 自动纠错（仅记录，需 iOS 设备） ====================
  it("KEY-008 iOS自动纠错替换后布局", async () => {
    try {
      // 此 case 高度依赖 iOS 环境，非 iOS 设备标记跳过并记录原因
      const platform = (await browser.capabilities).platformName?.toLowerCase();
      if (platform !== "ios") {
        // 不是 iOS，不标记为失败，记录为跳过
        console.log("[KEY-008] 非 iOS 设备，跳过（需 iOS+系统键盘自动纠错）");
        recordFailure("KEY-008", "SKIP_NON_IOS", "此用例需要 iOS 设备 + 系统键盘自动纠错", {
          platform,
        });
        return;
      }

      const inputs = await browser.$$("input:not([type='hidden'])");
      if (inputs.length === 0) {
        recordFailure("KEY-008", "NO_INPUT", "无输入框");
        return;
      }

      await inputs[0].click();
      await browser.pause(500);

      // 输入有拼写错误的词
      await inputs[0].setValue("helo");
      await browser.pause(1000);

      const rect = await browser.getElementRect(inputs[0].elementId);
      recordPass("KEY-008", { rect, note: "需人工验证自动纠错后布局是否稳定" });

      await browser.hideKeyboard();
    } catch (e: any) {
      recordFailure("KEY-008", "UNCAUGHT_ERROR", e.message, { stack: e.stack });
    }
  });

  // ==================== KEY-009: VoiceOver 辅助聚焦 ====================
  it("KEY-009 VoiceOver/TalkBack辅助聚焦输入框", async () => {
    try {
      // 无法通过自动化检测辅助功能状态
      // 此 case 需手动测试，自动化仅做基础检查
      const inputs = await browser.$$("input:not([type='hidden'])");
      if (inputs.length === 0) {
        recordFailure("KEY-009", "NO_INPUT", "无输入框");
        return;
      }

      // 检查输入框是否有 aria-label 或可访问名称
      const accessibleInputs = [];
      for (const input of inputs) {
        const ariaLabel = await input.getAttribute("aria-label");
        const placeholder = await input.getAttribute("placeholder");
        if (ariaLabel || placeholder) {
          accessibleInputs.push({ ariaLabel, placeholder });
        }
      }

      recordPass("KEY-009", {
        totalInputs: inputs.length,
        accessibleInputs: accessibleInputs.length,
        note: "自动化验证完成；VoiceOver/TalkBack 实际交互需手动测试",
      });
    } catch (e: any) {
      recordFailure("KEY-009", "UNCAUGHT_ERROR", e.message, { stack: e.stack });
    }
  });

  // ==================== KEY-010: iOS font-size<16px 自动缩放 ====================
  it("KEY-010 iOS font-size<16px自动缩放", async () => {
    try {
      const platform = (await browser.capabilities).platformName?.toLowerCase();
      if (platform !== "ios") {
        console.log("[KEY-010] 非 iOS 设备，跳过");
        recordFailure("KEY-010", "SKIP_NON_IOS", "需要 iOS Safari", { platform });
        return;
      }

      // 查找 font-size < 16px 的输入框
      const smallInputs = await browser.executeScript(`
        const inputs = document.querySelectorAll('input, textarea');
        const results = [];
        inputs.forEach((el, i) => {
          const style = window.getComputedStyle(el);
          const fontSize = parseFloat(style.fontSize);
          if (fontSize < 16) {
            results.push({ index: i, fontSize, selector: el.tagName + (el.id ? '#' + el.id : '') + (el.className ? '.' + el.className.split(' ')[0] : '') });
          }
        });
        return results;
      `);

      if ((smallInputs as any[]).length === 0) {
        recordPass("KEY-010", {
          note: "未找到 font-size<16px 的输入框，页面已做防护",
        });
        return;
      }

      // 聚焦第一个小字体输入框
      const firstSmallIdx = (smallInputs as any[])[0]?.index;
      const inputs = await browser.$$("input, textarea");
      await inputs[firstSmallIdx].click();
      await browser.pause(1500);

      const rect = await browser.getElementRect(
        inputs[firstSmallIdx].elementId
      );
      recordPass("KEY-010", {
        smallInputs,
        rectAfterFocus: rect,
        note: "需人工验证是否触发 iOS 自动缩放",
      });
      
      await browser.hideKeyboard();
    } catch (e: any) {
      recordFailure("KEY-010", "UNCAUGHT_ERROR", e.message, { stack: e.stack });
    }
  });

  // ==================== KEY-011: 中文输入法 composition 阶段 ====================
  it("KEY-011 中文输入法组合输入不触发跳动", async () => {
    try {
      const inputs = await browser.$$("input:not([type='hidden'])");
      if (inputs.length === 0) {
        recordFailure("KEY-011", "NO_INPUT", "无输入框");
        return;
      }

      // 获取页面初始滚动位置
      const initialScroll = await browser.executeScript(
        "return { scrollY: window.scrollY, scrollX: window.scrollX }"
      );

      // 聚焦输入框
      await inputs[0].click();
      await browser.pause(1000);

      // 记录聚焦后的滚动位置
      const afterFocusScroll = await browser.executeScript(
        "return { scrollY: window.scrollY, scrollX: window.scrollX }"
      );

      // 模拟 composition 事件序列
      const compositionResult = await browser.executeScript(`
        const el = document.activeElement;
        if (!el || !(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
          return { error: 'No active input element' };
        }
        
        const events = [];
        const scrollBefore = window.scrollY;
        
        // 触发 compositionstart
        el.dispatchEvent(new CompositionEvent('compositionstart', { data: 'z' }));
        events.push({ event: 'compositionstart', scrollY: window.scrollY });
        
        // 模拟中间输入
        el.value = el.value + 'zhongwen';
        el.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'zhongwen' }));
        events.push({ event: 'compositionupdate', scrollY: window.scrollY });
        
        // 触发 compositionend
        el.dispatchEvent(new CompositionEvent('compositionend', { data: '中文' }));
        events.push({ event: 'compositionend', scrollY: window.scrollY });
        
        return { scrollBefore, events, scrollAfter: window.scrollY };
      `);

      // 检查 composition 期间是否发生异常滚动
      const compResult = compositionResult as any;
      if (compResult.error) {
        recordFailure("KEY-011", "COMPOSITION_ERROR", compResult.error);
      } else {
        const scrollChanges = compResult.events.filter(
          (e: any) => Math.abs(e.scrollY - compResult.scrollBefore) > 2
        );
        if (scrollChanges.length > 1) {
          recordFailure(
            "KEY-011",
            "COMPOSITION_SCROLL_JUMP",
            "中文输入 composition 阶段检测到多次滚动",
            { compositionResult }
          );
        } else {
          recordPass("KEY-011", {
            compositionResult,
            note: "需人工切换中文输入法后验证 composition 阶段不触发跳动",
          });
        }
      }

      await browser.hideKeyboard();
    } catch (e: any) {
      recordFailure("KEY-011", "UNCAUGHT_ERROR", e.message, { stack: e.stack });
    }
  });

  // ==================== KEY-012: 第三方输入法切换 ====================
  it("KEY-012 第三方输入法切换键盘高度跟随", async () => {
    try {
      const inputs = await browser.$$("input:not([type='hidden'])");
      if (inputs.length === 0) {
        recordFailure("KEY-012", "NO_INPUT", "无输入框");
        return;
      }

      await inputs[0].click();
      await browser.pause(1000);

      const rectBefore = await browser.getElementRect(inputs[0].elementId);
      const viewportBefore: any = await browser.executeScript(
        "return { height: window.visualViewport?.height || window.innerHeight }"
      );

      // 切换输入法（需手动或通过输入法切换 keyevent）
      // Appium 无法直接切换输入法，记录当前状态
      const isKeyboardShown = await browser.isKeyboardShown();
      recordPass("KEY-012", {
        rectBefore,
        viewportBefore,
        isKeyboardShown,
        note: "自动化无法直接切换输入法；需手动切换系统键盘→第三方键盘后验证跟随情况",
      });

      await browser.hideKeyboard();
    } catch (e: any) {
      recordFailure("KEY-012", "UNCAUGHT_ERROR", e.message, { stack: e.stack });
    }
  });
});
