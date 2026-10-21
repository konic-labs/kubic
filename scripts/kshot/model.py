"""A scripted model for kshot.

An OpenAI-compatible chat endpoint on a loopback port that answers each
request with the next reply of a script, so a scenario can show a real
session, real prompts and real tool calls, with no model and no network.
`kshot.py`'s `model` step serves one and registers it with Kubic through a
models.json in the scenario's HOME.

A script is JSON:

  {"provider": "demo", "model": "scripted",
   "replies": [
     {"text": "I'll read the module first.",
      "tools": [{"name": "read", "arguments": {"path": "src/slug.js"}}]},
     {"text": "Done: slugify now strips accents.", "delay": 600}
   ]}

Each request takes the next reply, in order. A reply streams its `text` a
word at a time, then its `tools` as tool calls, then its token usage; `delay`
holds it back first (ms, default 300) and `pace` is the time between words
(ms, default 25). `usage` ({"input": n, "output": n}) sets the tokens it
reports, which are otherwise fixed by its place in the script, so a frame
never depends on the request's exact size. A request after the last reply is
answered with an error that says so.
"""

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DEFAULT_DELAY_MS = 300
DEFAULT_PACE_MS = 25
CONTEXT_WINDOW = 200000
MAX_TOKENS = 8192


class ScriptError(Exception):
    """A script kshot cannot serve."""


def load_script(text):
    """The parsed script, refused with the first problem found."""
    try:
        script = json.loads(text)
    except json.JSONDecodeError as error:
        raise ScriptError(f'the model script is not JSON: {error}') from None
    if not isinstance(script, dict):
        raise ScriptError('the model script must be a JSON object')
    for key in ('provider', 'model'):
        if not isinstance(script.get(key, ''), str):
            raise ScriptError(f'"{key}" must be a string')
    replies = script.get('replies')
    if not isinstance(replies, list) or not replies:
        raise ScriptError('"replies" must be a non-empty list')
    for n, reply in enumerate(replies, 1):
        if not isinstance(reply, dict):
            raise ScriptError(f'reply {n} must be an object')
        unknown = set(reply) - {'text', 'tools', 'delay', 'pace', 'usage'}
        if unknown:
            raise ScriptError(f'reply {n} has unknown keys: {", ".join(sorted(unknown))}')
        if 'text' not in reply and 'tools' not in reply:
            raise ScriptError(f'reply {n} needs "text" or "tools"')
        for tool in reply.get('tools', []):
            if not isinstance(tool, dict) or not isinstance(tool.get('name'), str) \
                    or not isinstance(tool.get('arguments', {}), dict):
                raise ScriptError(f'reply {n}: a tool needs a "name" and an "arguments" object')
    return script


def provider_entry(script, base_url):
    """The models.json provider that points Kubic at the scripted model."""
    return {
        'baseUrl': base_url,
        'api': 'openai-completions',
        'apiKey': 'not-needed',
        'models': [{'id': script.get('model', 'scripted'),
                    'contextWindow': CONTEXT_WINDOW, 'maxTokens': MAX_TOKENS}],
    }


def reply_chunks(reply, index, model):
    """The SSE chunks of one reply, as (seconds to wait first, JSON body)."""
    base = {'id': f'kshot-{index}', 'object': 'chat.completion.chunk',
            'created': 0, 'model': model}

    def chunk(delta, finish=None):
        return dict(base, choices=[{'index': 0, 'delta': delta, 'finish_reason': finish}])

    pace = reply.get('pace', DEFAULT_PACE_MS) / 1000
    out = []
    first = reply.get('delay', DEFAULT_DELAY_MS) / 1000
    words = reply.get('text', '').split(' ') if reply.get('text') else []
    for i, word in enumerate(words):
        piece = word if i == 0 else f' {word}'
        delta = {'content': piece}
        if i == 0:
            delta['role'] = 'assistant'
        out.append((first if i == 0 else pace, chunk(delta)))
    tools = reply.get('tools', [])
    for i, tool in enumerate(tools):
        call = {'index': i, 'id': f'call_{index}_{i}', 'type': 'function',
                'function': {'name': tool['name'],
                             'arguments': json.dumps(tool.get('arguments', {}))}}
        delta = {'tool_calls': [call]}
        if not out:
            delta['role'] = 'assistant'
        out.append((first if not out else pace, chunk(delta)))
    out.append((0, chunk({}, 'tool_calls' if tools else 'stop')))
    usage = reply.get('usage', {})
    prompt = usage.get('input', 1800 + 700 * index)
    completion = usage.get('output', 24 + 3 * len(words) + 40 * len(tools))
    out.append((0, dict(base, choices=[], usage={
        'prompt_tokens': prompt, 'completion_tokens': completion,
        'total_tokens': prompt + completion})))
    return out


class ScriptedModel:
    """The endpoint, serving on 127.0.0.1 until close()."""

    def __init__(self, script):
        self.script = script
        self.next = 0
        self.lock = threading.Lock()
        model = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                if self.path.rstrip('/').endswith('/models'):
                    self.send_json(200, {'object': 'list', 'data': [
                        {'id': model.script.get('model', 'scripted'), 'object': 'model'}]})
                else:
                    self.send_json(404, {'error': {'message': f'no route {self.path}'}})

            def do_POST(self):
                length = int(self.headers.get('Content-Length') or 0)
                self.rfile.read(length)
                if not self.path.rstrip('/').endswith('/chat/completions'):
                    self.send_json(404, {'error': {'message': f'no route {self.path}'}})
                    return
                index, reply = model.take()
                if reply is None:
                    self.send_json(400, {'error': {'message': (
                        f'kshot: the model script has no reply {index + 1}')}})
                    return
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.send_header('Cache-Control', 'no-cache')
                self.end_headers()
                for wait, body in reply_chunks(reply, index, model.script.get('model', 'scripted')):
                    time.sleep(wait)
                    self.wfile.write(f'data: {json.dumps(body)}\n\n'.encode())
                    self.wfile.flush()
                self.wfile.write(b'data: [DONE]\n\n')
                self.wfile.flush()

            def send_json(self, status, body):
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server.daemon_threads = True
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    @property
    def base_url(self):
        return f'http://127.0.0.1:{self.port}/v1'

    def take(self):
        with self.lock:
            index = self.next
            self.next += 1
        replies = self.script['replies']
        return index, replies[index] if index < len(replies) else None

    def close(self):
        self.server.shutdown()
        self.server.server_close()
