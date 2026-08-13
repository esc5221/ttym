import { readFile, writeFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { getHomeDir } from './session.js';

/**
 * 작업 지도 요약기의 지시문 — 단일 원천.
 *
 * CLI(`ttym map refresh`)는 이 지시문을 GET /api/map/prompt로 받아 쓰고,
 * 사용자는 settings에서 편집한다. 편집본은 ~/.ttym/map-prompt.txt에 살고,
 * 파일이 없으면 아래 기본값이 유효본이다. 데이터 블록(workspace 목록·화면
 * 꼬리)은 CLI가 기계적으로 뒤에 붙이는 부분이라 편집 대상이 아니다.
 */
export const DEFAULT_MAP_PROMPT = `너는 터미널 멀티플렉서의 "작업 지도" 요약가다. 아래 세션들의 최근 화면을 읽고 JSON으로만 답하라.

규칙:
- 화면에 보이는 것만 말한다. 안 보이는 진행상황을 지어내지 마라. 판단 불가면 note는 빈 문자열.
- title: 작업을 부르는 이름 3~20자 (예: "PR#899", "gemma4 서빙"). 이전 title이 있고 같은 작업이면 그대로 유지.
- note: 한 줄 현황, 60자 이내, 평서형 짧게. 존댓말 금지.
- status: "wait"(사용자의 결정·응답을 기다림) | "run"(진행 중) | "done"(완료 보고) | "warn"(문제·사고 발견) | null
- statusNote: 상태 꼬리표 12자 이내 (예: "머지 대기", "Ben 답장 대기"). status가 null이면 빈 문자열.
- workspaces: 모든 workspace에 stream(줄기 이름)과 column(1|2|3), order(열 안 순서 0부터)를 부여.
  stream 이름은 화면에 보이는 실제 대상에서 따라라 — 레포·제품·주제명 (예: "gpai", "ttym", "gemma4 리서치").
  "회사"/"개인"/"기타" 같은 추상 관리 분류는 금지. 같은 레포·제품을 다루는 workspace는 같은 stream.
  column은 배치 힌트: 활동이 활발한 줄기일수록 1(왼쪽), 휴면·상비 줄기는 3(오른쪽).
  기존 배치가 주어지면 특별한 이유 없이 바꾸지 마라.

출력 형식 (JSON만, 다른 텍스트 금지):
{"sessions":{"<세션id>":{"title":"","note":"","status":null,"statusNote":""}},"workspaces":{"<wsId>":{"stream":"","column":1,"order":0}}}`;

function promptPath(): string {
  return resolve(getHomeDir(), 'map-prompt.txt');
}

/** 유효 지시문: 편집 파일이 있으면 그것, 없으면 기본값. */
export async function readMapPrompt(): Promise<{ prompt: string; isDefault: boolean }> {
  try {
    const custom = (await readFile(promptPath(), 'utf8')).trim();
    if (custom) return { prompt: custom, isDefault: false };
  } catch {}
  return { prompt: DEFAULT_MAP_PROMPT, isDefault: true };
}

/** 빈 문자열/공백은 리셋 — 파일을 지워 기본값으로 돌아간다. */
export async function writeMapPrompt(prompt: string): Promise<{ prompt: string; isDefault: boolean }> {
  const trimmed = prompt.trim();
  if (!trimmed || trimmed === DEFAULT_MAP_PROMPT.trim()) {
    await unlink(promptPath()).catch(() => {});
    return { prompt: DEFAULT_MAP_PROMPT, isDefault: true };
  }
  await writeFile(promptPath(), trimmed + '\n');
  return { prompt: trimmed, isDefault: false };
}
