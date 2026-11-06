#!/usr/bin/env python3
"""Replay a member-session compaction summary against a chat-completions gateway.

Usage:
  zstd -dc session.v4.jsonl.zstd > /tmp/session.jsonl
  python3 replay-compaction.py /tmp/session.jsonl [budgetTokens] [provider/model] [max_tokens]

Defaults: budget 266000, model auto/deepseek-v4.1-flash, max_tokens 16384.
Gateway: $GATEWAY_URL or http://127.0.0.1:3425/v1/chat/completions

It projects the session's user/assistant/tool events into chat messages (keeping
reasoning as `reasoning_content` and tool calls paired with results), appends the
Harness compaction instruction verbatim, and prints finish_reason plus the usage
breakdown — enough to tell "model burned the cap on thinking" from "cap too small".
"""
import json
import os
import sys
import time
import urllib.request

GATEWAY = os.environ.get('GATEWAY_URL', 'http://127.0.0.1:3425/v1/chat/completions')

# Verbatim from packages/compaction/compaction-basic/src/summarizer.ts (COMPACTION_INSTRUCTION).
COMPACTION_INSTRUCTION = "\n".join([
    'You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.',
    '',
    'Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.',
    '',
    '## Primary Request and Intent',
    '', '## Key Technical Concepts', '', '## Files and Code', '',
    '## Errors and Fixes', '', '## Pending Jobs', '', '## Current Work', '',
    '## Next Step', '', '## Critical Context',
    '',
    'Rules:',
    '- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.',
    '- Do NOT mention this summarization request or that the context was compacted.',
    '- Output only the checkpoint text: do not call any tool or take any other action.',
])


def estimate(message):
    """Cheap token estimate: ASCII / 3.8 + non-ASCII / 1.6."""
    text = (message.get('content') or '') + (message.get('reasoning_content') or '')
    if message.get('tool_calls'):
        text += json.dumps(message['tool_calls'], ensure_ascii=False)
    ascii_chars = sum(1 for ch in text if ord(ch) < 128)
    return ascii_chars / 3.8 + (len(text) - ascii_chars) / 1.6


def project(path, budget):
    """Project events into chat messages using the OLDEST span up to `budget` tokens."""
    out, total = [], 0.0
    with open(path, encoding='utf-8') as handle:
        for line in handle:
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            kind = event.get('type')
            data = event.get('data') or {}
            message = None
            if kind == 'user/message':
                text = ''.join(b.get('text', '') for b in data.get('content') or [] if b.get('type') == 'text')
                if text:
                    message = {'role': 'user', 'content': text}
            elif kind == 'assistant/message':
                blocks = (data.get('message') or {}).get('content') or []
                text = ''.join(b.get('text', '') for b in blocks if b.get('type') == 'text')
                reasoning = ''.join(b.get('text', '') for b in blocks if b.get('type') == 'reasoning')
                calls = [{'id': b['id'], 'type': 'function',
                          'function': {'name': b['name'], 'arguments': b['arguments']}}
                         for b in blocks if b.get('type') == 'tool-call']
                message = {'role': 'assistant', 'content': text}
                if calls:
                    message['tool_calls'] = calls
                if reasoning:
                    message['reasoning_content'] = reasoning
            elif kind == 'tool/result':
                tool_message = data.get('message') or {}
                text = ''.join(b.get('text', '') for b in tool_message.get('content') or []
                               if b.get('type') == 'text')
                message = {'role': 'tool', 'tool_call_id': tool_message.get('toolCallId'), 'content': text}
            if message is None:
                continue
            size = estimate(message)
            if total + size > budget:
                break
            if message['role'] == 'tool' and not out:
                continue
            out.append(message)
            total += size
    # never end on an unmatched tool call / dangling tool result
    while out and out[-1]['role'] == 'assistant' and out[-1].get('tool_calls'):
        out.pop()
    while out and out[-1]['role'] == 'tool':
        out.pop()
    return out, total


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        raise SystemExit(2)
    path = sys.argv[1]
    budget = float(sys.argv[2]) if len(sys.argv) > 2 else 266000
    model = sys.argv[3] if len(sys.argv) > 3 else 'auto/deepseek-v4.1-flash'
    max_tokens = int(sys.argv[4]) if len(sys.argv) > 4 else 16384

    messages, total = project(path, budget)
    payload = {
        'model': model,
        'messages': messages + [{'role': 'user', 'content': COMPACTION_INSTRUCTION}],
        'max_tokens': max_tokens,
        'stream': False,
    }
    print(f'input≈{int(total)} tokens, {len(messages)} messages, model={model}, max_tokens={max_tokens}',
          flush=True)
    request = urllib.request.Request(GATEWAY, data=json.dumps(payload).encode(),
                                     headers={'content-type': 'application/json'})
    started = time.time()
    try:
        with urllib.request.urlopen(request, timeout=1800) as response:
            body = json.load(response)
    except Exception as exc:  # noqa: BLE001 - diagnostic script
        print('ERROR', type(exc).__name__, exc, f'{time.time() - started:.0f}s')
        try:
            print(exc.read().decode()[:2000])
        except Exception:  # noqa: BLE001
            pass
        return
    elapsed = time.time() - started
    choice = (body.get('choices') or [{}])[0]
    message = choice.get('message') or {}
    usage = body.get('usage') or {}
    details = usage.get('completion_tokens_details') or {}
    print(f'elapsed {elapsed:.0f}s finish_reason={choice.get("finish_reason")} '
          f'routed_model={body.get("model")}')
    print(f'completion_tokens={usage.get("completion_tokens")} '
          f'reasoning_tokens={details.get("reasoning_tokens")}')
    print(f'content_chars={len(message.get("content") or "")} '
          f'reasoning_chars={len(message.get("reasoning_content") or "")}')
    print('--- content head ---')
    print((message.get('content') or '')[:800])
    print('--- content tail ---')
    print((message.get('content') or '')[-800:])


if __name__ == '__main__':
    main()
