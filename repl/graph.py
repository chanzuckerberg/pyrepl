
class CachedGraph:
    def __init__(self, graph):
        self.graph = graph
        self.cache = {}

    def eval(self, key):
        val = self.cache.get(key, None)
        if (val is None):
            val = self.__eval(self.graph[key])
            self.cache[key] = val
        return val

    def __eval(self, exp):
        if type(exp) is tuple:
            f = exp[0]
            args = [ self.__eval(arg) for arg in exp[1:] ]
            return f(*args)
        elif type(exp) is list:
            return [ self.__eval(e) for e in exp ]
        elif type(exp) is str:
            # return self.__eval(self.graph[exp])
            return self.eval(exp)
        else:
            return exp

    def set(self, key, exp):
        # XXX: invalidate any key that references key
        self.graph[key] = exp
        for k, v in self.references('a').items():
            if v:
                self.cache.pop(k)

    def references(self, key):
        """ find all named computations in the graph that reference 'key' """
        doesReference = {}
        for k, e in self.graph.items():
            doesReference[k] = self.__references(key, k, e, doesReference)
        return doesReference

    def __references(self, key, nodeName, nodeExp, doesReference):
        # don't repeat previously explored nodes
        if doesReference.get(nodeName) is not None:
            return doesReference[nodeName]

        # Expand expression looking for references to key
        if type(nodeExp) is tuple:
            res = any([self.__references(key, nodeName, e, doesReference) for e in nodeExp[1:]])
        elif type(nodeExp) is list:
            res = any([self.__references(key, nodeName, e, doesReference) for e in nodeExp])
        elif type(nodeExp) is str:
            res = (nodeExp == key) or self.__references(key, nodeExp, self.graph[nodeExp], doesReference)
            doesReference[nodeExp] = res
        else:
            res = False
        return res
