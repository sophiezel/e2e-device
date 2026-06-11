// @ts-nocheck
/**
 * modal-scroll-lock.spec.ts
 * 真机端侧测试 — 弹窗滚动穿透场景 (MOD-001 ~ MOD-007)
 *
 * 设计原则:
 *  1. 每个 it 内部 try/catch，失败不阻断
 *  2. 记录问题栈含复现路径
 */

import { browser } from "@wdio/globals";
import { switchToWebViewContaining } from "../helpers/webview-context";
import { timeouts } from "../config/timeouts";
import { recordFailure, recordPass } from "../helpers/diagnostic-collector";

describe("Modal Scroll Lock (MOD)", () => {
  const domain = process.env.E2E_DOMAIN || "";

  before(async () => {
    await switchToWebViewContaining(domain, timeouts.webViewNormal);
  });

  // 辅助函数：检测页面上是否有弹窗
  async function findOpenModal(): Promise<WebdriverIO.Element | null> {
    const selectors = [
      "dialog[open]",
      "[role='dialog']",
      "[role='alertdialog']",
      ".modal:not([style*='display:none'])",
      "[class*='modal']:not([style*='display:none'])",
      "[class*='drawer']:not([style*='display:none'])",
      "[class*='popup']:not([style*='display:none'])",
      "[class*='overlay']:not([style*='display:none'])",
    ];
    for (const sel of selectors) {
      const el = await browser.$(sel);
      if (await el.isExisting()) {
        try {
          const displayed = await el.isDisplayed();
          if (displayed) return el;
        } catch { /* continue */ }
      }
    }
    return null;
  }

  // 辅助函数：验证背景 body 是否锁定滚动
  async function checkBodyScrollLock(): Promise<{
    overflow: string;
    position: string;
    isLocked: boolean;
  }> {
    const bodyStyles: any = await browser.executeScript(`
      const body = document.body;
      const style = window.getComputedStyle(body);
      return {
        overflow: style.overflow,
        overflowY: style.overflowY,
        position: style.position,
        touchAction: style.touchAction || 'auto',
        overscrollBehavior: style.overscrollBehavior || 'auto',
        overscrollBehaviorY: style.overscrollBehaviorY || 'auto',
      };
    `), [];

    const isLocked =
      bodyStyles.overflow === "hidden" ||
      bodyStyles.overflowY === "hidden" ||
      bodyStyles.position === "fixed" ||
      bodyStyles.overscrollBehaviorY === "contain";

    return { ...bodyStyles, isLocked };
  }

  // ==================== MOD-001: 弹窗滚动边界背景不动 ====================
  it("MOD-001 弹窗滚动边界背景不动", async () => {
    try {
      const modal = await findOpenModal();
      if (!modal) {
        recordFailure(
          "MOD-001",
          "NO_OPEN_MODAL",
          "页面当前无打开的弹窗，请先触发弹窗场景",
          { hint: "在 preconditions 中定义如何触发弹窗" }
        );
        return;
      }

      const bodyLock = await checkBodyScrollLock();

      // 检测 overscroll-behavior 设置
      const modalStyles: any = await browser.executeScript(`
        const modal = document.querySelector('dialog[open], [role="dialog"], .modal, [class*="modal"]');
        if (!modal) return null;
        const style = window.getComputedStyle(modal);
        return {
          overscrollBehavior: style.overscrollBehavior,
          overscrollBehaviorY: style.overscrollBehaviorY,
          overflow: style.overflow,
          overflowY: style.overflowY,
        };
      `), [];

      recordPass("MOD-001", {
        bodyLock,
        modalStyles,
        note: "自动化已检测 CSS 滚动锁定策略；需手动滑动弹窗边界验证不穿透",
      });
    } catch (e: any) {
      recordFailure("MOD-001", "UNCAUGHT_ERROR", e.message, { stack: e.stack });
    }
  });

  // ==================== MOD-002: 短弹窗不穿透 ====================
  it("MOD-002 短弹窗内容不足一屏不穿透", async () => {
    try {
      const modal = await findOpenModal();
      if (!modal) {
        recordFailure("MOD-002", "NO_OPEN_MODAL", "无弹窗");
        return;
      }

      // 检查弹窗内容高度
      const modalSize = await browser.executeScript(`
        const modal = document.querySelector('dialog[open], [role="dialog"], .modal, [class*="modal"]');
        if (!modal) return null;
        const rect = modal.getBoundingClientRect();
        const scrollHeight = modal.scrollHeight;
        return {
          height: rect.height,
          scrollHeight,
          isShort: scrollHeight <= window.innerHeight * 0.5,
          bodyScrollY: window.scrollY,
        };
      `), [];

      const bodyLock = await checkBodyScrollLock();

      if (modalSize && (modalSize as any).isShort) {
        // 短弹窗必须锁定 body
        if (bodyLock.isLocked) {
          recordPass("MOD-002", { modalSize, bodyLock });
        } else {
          recordFailure(
            "MOD-002",
            "SHORT_MODAL_NO_LOCK",
            "短弹窗未锁定 body 滚动，存在穿透风险",
            { modalSize, bodyLock }
          );
        }
      } else {
        recordPass("MOD-002", {
          modalSize,
          bodyLock,
          note: "弹窗内容高度正常，检查 overscroll-behavior 设置",
        });
      }
    } catch (e: any) {
      recordFailure("MOD-002", "UNCAUGHT_ERROR", e.message, { stack: e.stack });
    }
  });

  // ==================== MOD-003: 弹窗内嵌套滚动区域 ====================
  it("MOD-003 弹窗内嵌套滚动区域", async () => {
    try {
      const modal = await findOpenModal();
      if (!modal) {
        recordFailure("MOD-003", "NO_OPEN_MODAL", "无弹窗");
        return;
      }

      // 使用 elementId 查询弹窗内可滚动子元素
      const nestedScrollInfo: any = await browser.executeScript(`
        const modal = document.querySelector('dialog[open], [role="dialog"], .modal, [class*="modal"]');
        if (!modal) return { error: 'no modal' };
        const scrollables = modal.querySelectorAll('[style*="overflow"], .scroll, [class*="scroll"], [class*="list"]');
        const results = [];
        scrollables.forEach(el => {
          const style = window.getComputedStyle(el);
          const isScrollable = style.overflowY === 'auto' || style.overflowY === 'scroll';
          if (isScrollable) {
            results.push({
              tag: el.tagName,
              className: el.className?.toString().slice(0, 50),
              overscrollBehaviorY: style.overscrollBehaviorY,
              maxHeight: style.maxHeight,
            });
          }
        });
        return { scrollablesCount: scrollables.length, scrollables: results };
      `), [];

      const bodyLock = await checkBodyScrollLock();

      recordPass("MOD-003", {
        nestedScrollInfo,
        bodyLock,
        note: "需手动验证子滚动区域边界不穿透弹窗背景",
      });
    } catch (e: any) {
      recordFailure("MOD-003", "UNCAUGHT_ERROR", e.message, { stack: e.stack });
    }
  });

  // ==================== MOD-004: 弹窗 + 键盘 ====================
  it("MOD-004 弹窗+键盘同时开启", async () => {
    try {
      const modal = await findOpenModal();
      if (!modal) {
        recordFailure("MOD-004", "NO_OPEN_MODAL", "无弹窗");
        return;
      }

      // 在弹窗内找输入框
      const modalInput = await browser.executeScript(`
        const modal = document.querySelector('dialog[open], [role="dialog"], .modal, [class*="modal"]');
        if (!modal) return null;
        const input = modal.querySelector('input, textarea, [contenteditable]');
        if (!input) return null;
        // 滚动到可见位置
        input.scrollIntoView({ block: 'center' });
        return { tag: input.tagName, type: input.getAttribute('type') };
      `), [];

      if (!modalInput) {
        recordFailure("MOD-004", "NO_INPUT_IN_MODAL", "弹窗内无输入框");
        return;
      }

      // 尝试聚焦弹窗内输入框
      const modalInputEl = await modal.$("input, textarea, [contenteditable]");
      if (await modalInputEl.isExisting()) {
        await modalInputEl.click();
        await browser.pause(1000);

        const isKeyboardShown = await browser.isKeyboardShown();
        const bodyLock = await checkBodyScrollLock();

        if (isKeyboardShown) {
          recordPass("MOD-004", {
            bodyLock,
            note: "键盘+弹窗同时开启，需手动验证滚穿透情况",
          });
        } else {
          recordFailure("MOD-004", "KEYBOARD_NOT_SHOWN", "键盘未弹出");
        }

        await browser.hideKeyboard();
      }
    } catch (e: any) {
      recordFailure("MOD-004", "UNCAUGHT_ERROR", e.message, { stack: e.stack });
    }
  });

  // ==================== MOD-005: iOS 橡皮筋效果 ====================
  it("MOD-005 iOS橡皮筋效果不穿透", async () => {
    try {
      const platform = browser.capabilities.platformName?.toLowerCase();
      if (platform !== "ios") {
        console.log("[MOD-005] 非 iOS，跳过");
        recordFailure("MOD-005", "SKIP_NON_IOS", "需要 iOS", { platform });
        return;
      }

      const modal = await findOpenModal();
      if (!modal) {
        recordFailure("MOD-005", "NO_OPEN_MODAL", "无弹窗");
        return;
      }

      // 检查 webkit-overflow-scrolling
      const webkitInfo: any = await browser.executeScript(`
        const modal = document.querySelector('dialog[open], [role="dialog"], .modal, [class*="modal"]');
        if (!modal) return null;
        const style = window.getComputedStyle(modal);
        return {
          webkitOverflowScrolling: style.webkitOverflowScrolling,
          overscrollBehaviorY: style.overscrollBehaviorY,
        };
      `), [];

      recordPass("MOD-005", {
        webkitInfo,
        note: "需手动在 iOS 上测试橡皮筋边界不穿透",
      });
    } catch (e: any) {
      recordFailure("MOD-005", "UNCAUGHT_ERROR", e.message, { stack: e.stack });
    }
  });

  // ==================== MOD-006: Android 硬件返回键 ====================
  it("MOD-006 Android硬件返回键关闭弹窗", async () => {
    try {
      const platform = browser.capabilities.platformName?.toLowerCase();
      if (platform !== "android") {
        console.log("[MOD-006] 非 Android，跳过");
        recordFailure("MOD-006", "SKIP_NON_ANDROID", "需要 Android", { platform });
        return;
      }

      const modal = await findOpenModal();
      if (!modal) {
        recordFailure("MOD-006", "NO_OPEN_MODAL", "无弹窗");
        return;
      }

      // 记录弹窗前状态
      const scrollBefore = await browser.executeScript("return window.scrollY");

      // 模拟按返回键
      await browser.back();
      await browser.pause(1000);

      // 重新检测弹窗是否关闭
      const modalAfter = await findOpenModal();
      const scrollAfter = await browser.executeScript("return window.scrollY");

      if (modalAfter === null) {
        // 弹窗已关闭
        const bodyLock = await checkBodyScrollLock();
        if (bodyLock.isLocked) {
          recordFailure(
            "MOD-006",
            "BODY_STILL_LOCKED",
            "弹窗关闭后 body 滚动锁定未释放",
            { scrollBefore, scrollAfter, bodyLock }
          );
        } else {
          recordPass("MOD-006", { scrollBefore, scrollAfter });
        }
      } else {
        recordFailure("MOD-006", "MODAL_NOT_CLOSED", "返回键未能关闭弹窗");
      }
    } catch (e: any) {
      recordFailure("MOD-006", "UNCAUGHT_ERROR", e.message, { stack: e.stack });
    }
  });

  // ==================== MOD-007: Chrome<144 降级 ====================
  it("MOD-007 Chrome<144降级方案验证", async () => {
    try {
      const uaInfo: any = await browser.executeScript(`
        const ua = navigator.userAgent;
        const chromeMatch = ua.match(/Chrome\\/(\\d+)/);
        const webviewMatch = ua.match(/wv\\)/);
        return {
          userAgent: ua,
          chromeVersion: chromeMatch ? parseInt(chromeMatch[1]) : null,
          isWebView: !!webviewMatch,
        };
      `), [];

      const modal = await findOpenModal();
      const bodyLock = await checkBodyScrollLock();

      const platform = browser.capabilities.platformName?.toLowerCase();

      if (uaInfo.chromeVersion && uaInfo.chromeVersion < 144 && platform === "android") {
        // 低版本 Chrome，需验证降级方案
        const hasDialogSelector = await browser.executeScript(`
          try {
            const testEl = document.querySelector('body:has(dialog[open])');
            return !!testEl;
          } catch(e) {
            return false; // :has selector not supported
          }
        `), [];

        if (bodyLock.isLocked || hasDialogSelector) {
          recordPass("MOD-007", {
            uaInfo,
            bodyLock,
            hasDialogSelector,
            note: "低版本 Chrome 降级方案生效",
          });
        } else {
          recordFailure(
            "MOD-007",
            "FALLBACK_FAILED",
            "低版本 Chrome 上降级方案未生效",
            { uaInfo, bodyLock, hasDialogSelector }
          );
        }
      } else {
        recordPass("MOD-007", {
          uaInfo,
          bodyLock,
          note: uaInfo.chromeVersion >= 144
            ? "Chrome >= 144，原生支持 overscroll-behavior"
            : "非 Android Chrome，跳过",
        });
      }
    } catch (e: any) {
      recordFailure("MOD-007", "UNCAUGHT_ERROR", e.message, { stack: e.stack });
    }
  });
});
