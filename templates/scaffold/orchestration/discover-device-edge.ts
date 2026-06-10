/**
 * discover-device-edge.ts
 * 从 case-registry/device-edge-cases.json 加载真机端侧边缘用例
 * 转换为统一的 CaseEntry 格式，供 discover-cases.ts 使用
 */

import fs from "node:fs";
import path from "node:path";
import type { CaseEntry } from "./discover-cases";
import { e2eDeviceRoot } from "./paths";

interface RegistryCase {
  id: string;
  category: string;
  name: string;
  description: string;
  priority: string;
  sentinel: boolean;
  profileLevel: string;
  averageDurationMs: number;
  chaosFactors: string[];
  tags: string[];
  preconditions: string[];
  steps: string[];
  expectedResult: string;
  failureCriteria: string[];
  spec: string;
}

interface DeviceEdgeRegistry {
  version: string;
  cases: RegistryCase[];
  metadata: {
    totalCases: number;
    byPriority: Record<string, number>;
    byCategory: Record<string, number>;
    estimates: Record<string, { caseCount: number; durationMinutes: number }>;
  };
}

/** 从 case-registry/device-edge-cases.json 加载端侧用例 */
export function deviceEdgeCases(): CaseEntry[] {
  const registryPath = path.join(
    e2eDeviceRoot(),
    "case-registry",
    "device-edge-cases.json"
  );
  if (!fs.existsSync(registryPath)) {
    if (process.env.E2E_DEBUG) {
      console.debug("[discover-device-edge] Registry not found:", registryPath);
    }
    return [];
  }

  try {
    const raw = fs.readFileSync(registryPath, "utf-8");
    const registry = JSON.parse(raw) as DeviceEdgeRegistry;
    return registry.cases.map((c) => ({
      id: c.id,
      spec: c.spec,
      tags: c.tags,
      source: "device-edge-registry",
      // 扩展字段
      category: c.category,
      name: c.name,
      description: c.description,
      priority: c.priority,
      sentinel: c.sentinel,
      profileLevel: c.profileLevel,
      averageDurationMs: c.averageDurationMs,
      chaosFactors: c.chaosFactors,
      preconditions: c.preconditions,
      steps: c.steps,
      expectedResult: c.expectedResult,
      failureCriteria: c.failureCriteria,
      metadata: {
        description: `${c.name} [${c.priority}]`,
        category: c.category,
        priority: c.priority,
        sentinel: c.sentinel,
        averageDurationMs: c.averageDurationMs,
        estimatedDuration: formatDuration(c.averageDurationMs),
      },
    }));
  } catch (err) {
    console.error("[discover-device-edge] Failed to parse registry:", err);
    return [];
  }
}

/** 获取 registry 元数据（用于 test-plan 展示） */
export function deviceEdgeMetadata(): DeviceEdgeRegistry["metadata"] | null {
  const registryPath = path.join(
    e2eDeviceRoot(),
    "case-registry",
    "device-edge-cases.json"
  );
  if (!fs.existsSync(registryPath)) return null;

  try {
    const raw = fs.readFileSync(registryPath, "utf-8");
    const registry = JSON.parse(raw) as DeviceEdgeRegistry;
    return registry.metadata;
  } catch {
    return null;
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(0)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m${rem}s`;
}
