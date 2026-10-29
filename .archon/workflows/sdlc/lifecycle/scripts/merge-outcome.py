"""The run's merge outcome: the first merge queue, or the one re-run after a base merge or a moved base."""
import json
import os

def value(name):
    return json.loads(os.environ['INPUTS_' + name.upper()])

first = value('first')
after_base_merge = value('after_base_merge')
after_base_move = value('after_base_move')
source, result = 'merge', first
if after_base_merge:
    source, result = 'merge-after-base-merge', after_base_merge
elif after_base_move:
    source, result = 'merge-after-base-move', after_base_move
result = result or {}
print(json.dumps({'merged': bool(result.get('merged')), 'urls': result.get('urls') or [],
                  'summary': result.get('summary') or '', 'source': source}))
