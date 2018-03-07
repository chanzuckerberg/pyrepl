
"""
Python REPL kernel which talks over std{in,out,err}.

Supports separate execution scopes (via separate global/local dicts -- does not
do full sandboxing).
"""
import builtins
import os
import sys
import mmap
import traceback
import time
import contextlib
import argparse
from InterposedIO import InterposedStringIO
import Marshal


# This assumes a singly threaded REPL loop, as we use a global to store state
# about current executing request and scope
#
named_scopes = {
    '__default__': {}
}
current_tid = None
codec = None


def send_message(**other):
    global codec

    e = dict(**other)
    e.setdefault('type', 'message')
    e.setdefault('tid', current_tid)
    e.setdefault('status', True)

    assert 'tid' in e
    assert 'type' in e
    assert 'content_type' in e

    try:
        codec.send(e, file=sys.__stderr__)
    except TypeError as exc:
        codec.send(error(request, 'MarshallingError', 'Encoding error: ' + str(exc)), file=sys.__stderr__)

def response(r, **other):
    return dict(
        {
            'type': 'response',
            'responseTo': None if r is None else r.get('type'),
            'status': True
        },
        **other)

def error(request, code, details):
    e = response(request, code=code, details=details, status=False)
    return e

def exception_raised(request):
    exc_type, exc_value, exc_traceback = sys.exc_info()
    lines = traceback.format_exception(exc_type, exc_value, exc_traceback)
    details = ''.join(line for line in lines)
    tid = request.get('tid')
    type = request.get('type')
    return error(request, 'UnhandledException', details)

def unknown_request_type(request, scope):
    return error(request, 'UnknownRequestType', 'unknown command type')

# echo / heartbeat / synch barrier
def do_echo(request, scope):
    return response(request, request=request)

def do_exit(request, scope):
    sys.exit()

def do_del_scope(request, scope):
    del_scope_name = request.get('value')
    if del_scope_name is None or named_scopes.pop(del_scope_name, None) is None:
        return error(request, 'BadArgument', "Scope name not currently in use")
    return response(request)

def do_new_scope(request, scope):
    new_scope_name = request.get('value')
    if new_scope_name is None or type(new_scope_name) is not str:
        return error(request, 'BadArgument', "Scope name must be a string")
    # XXX: does the scope need to be initialized with anything else?
    named_scopes[new_scope_name] = {
        '__builtins__': __builtins__,
        '__name__': 'pyrepl'
    }
    return response(request)

def setGlobalState(scope, request):
    if request['state'] is None:
        return
    for k, v in request['state'].items():
        scope[k] = v

def do_eval(request, scope):
    try:
        setGlobalState(scope, request);
        value = eval(request['code'], scope)
        return response(request, value=value)
    except:
        return exception_raised(request)

def do_exec(request, scope):
    try:
        setGlobalState(scope, request);
        exec(request['code'], scope)
        return response(request)
    except:
        return exception_raised(request)

def do_rls_shmem(request, scope):
    global codec
    try:
        codec.rls_shmem(request['offset'])
        return response(request)
    except:
        return exception_raised(request)

request_handlers = {
    'echo': do_echo,
    'exit': do_exit,
    'eval': do_eval,
    'exec': do_exec,
    'newScope': do_new_scope,
    'delScope': do_del_scope,
    'rlsShmem': do_rls_shmem
}

def dispatch(request):
    global named_scopes, current_tid, codec
    pdu_type = request.get('type')
    scope_name = request.get('scope', '__default__')
    tid = request.get('tid')
    start_time = time.perf_counter()

    if not pdu_type:
        resp = error(request, 'BadArgument', 'Request has no "type" key')
    elif not scope_name in named_scopes:
        resp = error(request, 'UnknownScopeName', 'Unknown "scope" name')
    else:
        scope = named_scopes[scope_name]
        current_tid = tid;
        hndl = request_handlers.get(pdu_type, unknown_request_type)
        resp = hndl(request, scope)

    stop_time = time.perf_counter()
    resp['elapsed_time'] = stop_time - start_time
    if tid:
        resp['tid'] = tid

    return resp


# Request/response loop processes stdin/stdout
# Async events are handled spearately and sent via stderr
#
def pdu_loop():
    global codec
    while True:
        resp = None
        try:
            request = codec.recv(sys.__stdin__)
            if not request:
                break   # on eof

            resp = dispatch(request)
        except Marshal.DecodeError as exc:
            resp = error(None, 'MarshallingError', str(exc))

        try:
            codec.send(resp, file=sys.__stdout__)
        except Marshal.UnsupportedType as exc:
            codec.send(error(request, 'MarshallingError', str(exc)), file=sys.__stdout__)

def mmapSharedObject(sysname):
    sinfo = os.stat(sysname)
    with open(sysname, 'rb+') as f:
        mem = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_WRITE)

    assert(sinfo.st_size == len(mem) == mem.size())
    return (mem, sinfo.st_size)

def main():
    global codec

    parser = argparse.ArgumentParser()
    parser.add_argument('-mmap', action='store')
    parser.add_argument('-bson', action='store_true')
    args = parser.parse_args()

    shmem_txfr_buf = None
    if args.mmap:
        (shmem, shmem_size) = mmapSharedObject(args.mmap)
        shmem_txfr_buf = Marshal.ShmemTransferBuffer('__default__', shmem, shmem_size);
        # set allocator to point to mem

    codec = Marshal.Codec('bson' if args.bson else 'json', shmem_txfr_buf)
    builtins.__dict__['pyrepl'] = __import__(__name__)

    out = InterposedStringIO(line_buffering = True, onflush = lambda s: send_message(content_type='text/plain', pipe='stdout', data=s))
    err = InterposedStringIO(line_buffering = True, onflush = lambda s: send_message(content_type='text/plain', pipe='stderr', data=s))
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        pdu_loop();

if __name__ == "__main__":
    main()
