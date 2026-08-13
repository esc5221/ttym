# ttym shell integration — 명령 경계를 OSC 133/633으로 스트림에 심는다.
# 서버가 이를 읽어 명령 인덱스(무엇을·언제·성패·출력구간)를 만든다.
#
# 설치: ~/.zshrc 에 아래 한 줄 (ttym pane 밖에서는 아무 일도 안 한다)
#   [[ -n "$TTYM_SESSION_ID" ]] && source ~/study/ttym/scripts/ttym-shell-integration.zsh
#
# 신호: 133;A 프롬프트 시작 · 133;B 입력 시작 · 133;C 출력 시작 ·
#       133;D;exit 종료 · 633;E;cmd 명령 원문(\\ → \\\\, ; → \x3b, 개행 → \x0a)

[[ -o interactive ]] || return 0
[[ -n "$TTYM_SESSION_ID" ]] || return 0
[[ -n "$__TTYM_SHELL_INTEGRATION" ]] && return 0
__TTYM_SHELL_INTEGRATION=1

autoload -Uz add-zsh-hook

__ttym_cmd_open=0

__ttym_precmd() {
  local st=$?
  if (( __ttym_cmd_open )); then
    printf '\e]133;D;%d\a' "$st"
    __ttym_cmd_open=0
  fi
  printf '\e]133;A\a'
}

__ttym_preexec() {
  local cmd=$1
  cmd=${cmd//\\/\\\\}
  cmd=${cmd//;/\\x3b}
  cmd=${cmd//$'\n'/\\x0a}
  printf '\e]133;B\a\e]633;E;%s\a\e]133;C\a' "$cmd"
  __ttym_cmd_open=1
}

add-zsh-hook precmd __ttym_precmd
add-zsh-hook preexec __ttym_preexec
