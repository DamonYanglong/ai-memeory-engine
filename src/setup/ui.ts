/**
 * 交互式 readline 工具函数
 * @author longfei5
 * @date 2026/3/12
 *
 * 基于 Node 内置 readline/promises，提供三种交互模式：
 * 文本输入、数字选择、Y/n 确认。
 */

import { createInterface, type Interface } from "node:readline";

/** 创建 readline 接口 */
export function createRL(): Interface {
  return createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

/** 封装 question 为 Promise */
function question(rl: Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve(answer));
  });
}

/**
 * 文本输入，支持默认值
 * @param rl readline 接口
 * @param prompt 提示文本
 * @param defaultValue 默认值（回车直接使用）
 */
export async function ask(
  rl: Interface,
  prompt: string,
  defaultValue?: string,
): Promise<string> {
  const suffix = defaultValue ? ` (${defaultValue})` : "";
  const answer = await question(rl, `${prompt}${suffix}: `);
  return answer.trim() || defaultValue || "";
}

/** 选项定义 */
export interface SelectOption {
  label: string;
  value: string;
}

/**
 * 数字选择菜单
 * @param rl readline 接口
 * @param prompt 提示文本
 * @param options 选项列表
 * @returns 选中的 value
 */
export async function select(
  rl: Interface,
  prompt: string,
  options: SelectOption[],
): Promise<string> {
  console.log(`\n${prompt}\n`);
  for (let i = 0; i < options.length; i++) {
    console.log(`  ${i + 1}. ${options[i].label}`);
  }
  console.log();

  while (true) {
    const answer = await question(rl, `请选择 (1-${options.length}): `);
    const num = parseInt(answer.trim(), 10);
    if (num >= 1 && num <= options.length) {
      return options[num - 1].value;
    }
    console.log("  无效选择，请重新输入");
  }
}

/**
 * Y/n 确认
 * @param rl readline 接口
 * @param prompt 提示文本
 * @returns true=确认, false=取消
 */
export async function confirm(rl: Interface, prompt: string): Promise<boolean> {
  const answer = await question(rl, `${prompt} (Y/n): `);
  const trimmed = answer.trim().toLowerCase();
  return trimmed === "" || trimmed === "y" || trimmed === "yes";
}
