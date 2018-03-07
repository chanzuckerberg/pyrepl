
import builtins
import functools

"""
async messaging hook
"""
send_message = builtins.pyrepl.send_message

def send_text(text, **kwargs):
    """ send raw text """
    send_message(content_type="text/plain", data=text, **kwargs)

def send_image(image, **kwargs):
    """ send a numpy array as an image """
    send_message(content_type="image/ndarray", data=image, shape=image.shape, **kwargs)

def snoop(func = None, name = None):
    """
    @snoop - displays function return value

    Usage:
    @snoop
    def my_func():
        ...
    """
    import functools
    if func is None:
        return functools.partial(snoop, name=name)
    name = name if name else func.__name__
    @functools.wraps(func)
    def wrapper(*args, **kwargs):
        ret = func(*args, **kwargs)
        print('# ' + name, '() --> ', ret)
        return ret
    return wrapper
