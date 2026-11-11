"""
Regenerates lib/aaf-template.json — the fixed "schema" part of every AAF file.

You never need to run this to use the app. It exists so the template can be
rebuilt and audited. It needs Python 3 and pyaaf2 (pip install pyaaf2).

An AAF file is self-describing: besides the timeline it carries a
MetaDictionary (every class and type definition) and a Dictionary (data,
container, codec, operation and parameter definitions). Those parts are the
same for every export, so we let pyaaf2 (a mature, MIT-licensed AAF library)
write them once, and lib/aaf.js copies them byte for byte into each export.
Everything that changes per export (mobs, timeline, embedded audio) is
written by lib/aaf.js itself.

    python3 tools/make-aaf-template.py
"""
import base64
import json
import os
import sys
import tempfile

import aaf2
from aaf2.auid import AUID
from aaf2.cfb import CompoundFileBinary

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'lib', 'aaf-template.json')

AMPLITUDE = "e4962321-2267-11d3-8a4c-0050040ef7d2"   # ParameterDef "Amplitude multiplier"
MONO_GAIN = "9d2ea894-0968-11d3-8a38-0050040ef7d2"   # OperationDef "Mono Audio Gain"


def build(path):
    with aaf2.open(path, 'w') as f:
        d = f.dictionary
        param = f.create.ParameterDef(AUID(AMPLITUDE), "Amplitude multiplier",
                                      "Amplitude multiplier", "Rational")
        d.register_def(param)
        op = f.create.OperationDef(AUID(MONO_GAIN), "Mono Audio Gain", "")
        op['DataDefinition'].value = d.lookup_datadef("DataDef_Sound")
        op['IsTimeWarp'].value = False
        op['NumberInputs'].value = 1
        op['Bypass'].value = 0
        op['ParametersDefined'].append(param)
        d.register_def(op)


def node(cfb, entry):
    out = {'name': entry.name}
    if entry.isdir():
        out['clsid'] = str(entry.class_id)
        out['children'] = [node(cfb, c) for c in
                           sorted(cfb.listdir(entry), key=lambda e: e.name)]
    else:
        s = cfb.open(entry.path())
        out['data'] = base64.b64encode(s.read()).decode('ascii')
    return out


def main():
    tmp = tempfile.mkdtemp()
    path = os.path.join(tmp, 'template.aaf')
    build(path)

    with open(path, 'rb') as fh:
        cfb = CompoundFileBinary(fh, 'rb')
        root = cfb.find('/')
        refs = cfb.open('/referenced properties').read()
        # decode the weak-reference path table
        import struct
        path_count, pid_count = struct.unpack_from('<HI', refs, 1)
        pids = struct.unpack_from('<%dH' % pid_count, refs, 7)
        table, cur = [], []
        for pid in pids:
            if pid == 0:
                table.append(cur)
                cur = []
            else:
                cur.append(pid)
        assert len(table) == path_count

        template = {
            'generator': 'pyaaf2 %s via tools/make-aaf-template.py' % getattr(aaf2, '__version__', ''),
            'rootClsid': str(root.class_id),
            'weakRefTable': table,
            'metaDictionary': node(cfb, cfb.find('/MetaDictionary-1')),
            'dictionary': node(cfb, cfb.find('/Header-2/Dictionary-3b04')),
        }

    with open(OUT, 'w') as fh:
        json.dump(template, fh, separators=(',', ':'))
    print('wrote', os.path.normpath(OUT), os.path.getsize(OUT), 'bytes')


if __name__ == '__main__':
    sys.exit(main())
