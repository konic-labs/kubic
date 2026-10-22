"""kshot's scripted model: the script, its chunks, and the endpoint itself
on a loopback port."""

import json
import unittest
import urllib.error
import urllib.request

import model


def stream(reply, index=0):
    return [body for _, body in model.reply_chunks(reply, index, 'scripted')]


class ScriptTest(unittest.TestCase):
    def test_refuses_a_script_it_cannot_serve(self):
        cases = {
            'not json': 'is not JSON',
            '[]': 'must be a JSON object',
            '{"replies": []}': '"replies" must be a non-empty list',
            '{"replies": [{}]}': 'reply 1 needs "text" or "tools"',
            '{"replies": [{"text": "a", "speed": 2}]}': 'unknown keys: speed',
            '{"replies": [{"tools": [{"arguments": {}}]}]}': 'a tool needs a "name"',
            '{"model": 7, "replies": [{"text": "a"}]}': '"model" must be a string',
        }
        for text, message in cases.items():
            with self.subTest(text=text):
                with self.assertRaises(model.ScriptError) as caught:
                    model.load_script(text)
                self.assertIn(message, str(caught.exception))

    def test_names_the_endpoint_for_models_json(self):
        entry = model.provider_entry({'model': 'scripted'}, 'http://127.0.0.1:9/v1')
        self.assertEqual(entry['api'], 'openai-completions')
        self.assertEqual(entry['models'][0]['id'], 'scripted')
        self.assertLess(entry['models'][0]['maxTokens'], entry['models'][0]['contextWindow'])


class ChunkTest(unittest.TestCase):
    def test_streams_words_then_tool_calls_then_usage(self):
        chunks = stream({'text': 'Reading it first.',
                         'tools': [{'name': 'read', 'arguments': {'path': 'a.js'}}]}, 2)
        deltas = [c['choices'][0]['delta'] for c in chunks if c['choices']]
        self.assertEqual(deltas[0], {'content': 'Reading', 'role': 'assistant'})
        self.assertEqual(''.join(d.get('content', '') for d in deltas), 'Reading it first.')
        call = deltas[3]['tool_calls'][0]
        self.assertEqual((call['id'], call['function']['name']), ('call_2_0', 'read'))
        self.assertEqual(json.loads(call['function']['arguments']), {'path': 'a.js'})
        self.assertEqual(chunks[-2]['choices'][0]['finish_reason'], 'tool_calls')
        self.assertEqual(chunks[-1]['usage']['prompt_tokens'], 1800 + 700 * 2)

    def test_a_text_reply_stops_and_reports_its_own_usage(self):
        chunks = stream({'text': 'Done.', 'usage': {'input': 10, 'output': 2}})
        self.assertEqual(chunks[-2]['choices'][0]['finish_reason'], 'stop')
        self.assertEqual(chunks[-1]['usage'],
                         {'prompt_tokens': 10, 'completion_tokens': 2, 'total_tokens': 12})

    def test_waits_before_the_first_chunk_then_paces_the_words(self):
        waits = [wait for wait, _ in model.reply_chunks(
            {'text': 'a b', 'delay': 500, 'pace': 40}, 0, 'm')]
        self.assertEqual(waits[:2], [0.5, 0.04])


class EndpointTest(unittest.TestCase):
    def setUp(self):
        self.served = model.ScriptedModel(model.load_script(json.dumps(
            {'replies': [{'text': 'hello there', 'delay': 0, 'pace': 0}]})))

    def tearDown(self):
        self.served.close()

    def post(self):
        request = urllib.request.Request(
            f'{self.served.base_url}/chat/completions', method='POST',
            data=json.dumps({'stream': True}).encode(),
            headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.read().decode()

    def test_answers_with_the_next_reply_then_says_the_script_ran_out(self):
        body = self.post()
        events = [line[6:] for line in body.split('\n') if line.startswith('data: ')]
        self.assertEqual(events[-1], '[DONE]')
        text = ''.join(json.loads(e)['choices'][0]['delta'].get('content', '')
                       for e in events[:-1] if json.loads(e)['choices'])
        self.assertEqual(text, 'hello there')
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.post()
        with caught.exception as error:
            self.assertIn('no reply 2', error.read().decode())


if __name__ == '__main__':
    unittest.main()
