(function() {

  /*** Expose main object or function ***/

  if (typeof define === "function" && define.amd) {
    define(function() { return Proceed; });
  } else if (typeof module === "object" && module.exports) {
    var Pipe = require('./pipe');
    module.exports = Proceed;
  } else {
    var Pipe = this.Pipe;
    this.Proceed = Proceed;
  }

  /*** Defaults ***/

  var defaultOpts = {
    /* global opts */
    concurrency: Infinity,
    min: 0,
    max: 100,
    cxt: null,

    /* per request opts */
    weight: 1, 
    retry: 3,
    data: null
  };


  /*** Helper Functions ***/

  var slice = [].slice;

  // Mixin (similar to $.extend, but only shallow)
  function mergeOpts(opts1, opts2) {
    var opts = {};
    Object.keys(opts1).forEach(function(key) {
      opts[key] = opts1[key];
    });
    Object.keys(opts2).forEach(function(key) {
      opts[key] = opts2[key];
    });
    return opts;
  }

  // Check if arg is an array
  function isArray(arg) {
    return Array.isArray(arg);
  }

  // Check if arg is a string
  function isString(arg) {
    return typeof arg === 'string';
  }

  function isObject(arg) {
    return typeof arg === 'object' && arg !== null;
  }


  /*** Class definition ***/

  /**
   * Create new instance of `Proceed`.
   * 
   * @param {Object} opts Options object to configure `Proceed` behavior.
   */
  function Proceed(opts, onSend, onProgress) {
    var self = this;
    self.opts = mergeOpts(defaultOpts, opts);
    self._pipe = new Pipe(1);
    self._p = self.opts.min; // Short for `self._progress`
    self._w = 0; // Short for `self._totalWeight`
    self._s = self.opts.max - self.opts.min; // Short for `self._scale`
    self._h = {}; // Short for `self._handlers`
    self._cbs = onSend; // Short for `self._sendCallback`
    self._cbp = onProgress; // Short for `self._progressCallback`
  }

  Proceed.prototype = {
    
    /**
     * Proceed after all resources are brought successful.
     * 
     * @return {Proceed} `this` for chaining.
     */
    all: function() {
      var self = this;
      var args = slice.call(arguments);
      
      var pipe = self._mkpipe(self._repeat, args, self.opts.concurrency, true);
      self._pipe.fill(function(done) {
        pipe.flush(self._get2(done));
      }, self);

      return self;
    },

    /**
     * Proceed after one successful resource is brought.
     * 
     * @return {Proceed} `this` for chaining
     */
    one: function() {
      var self = this;
      var args = slice.call(arguments);

      var pipe = self._mkpipe(self._repeat, args, 1, true);
      self._pipe.fill(function(done) {
        pipe.flush(self._adjust(self._get1(done), args));
      }, self);

      return self;
    },

    /**
     * Start proceeding.
     * 
     * @param {Function} done Callback when everything is complete.
     * @return {Proceed} `this` for chaining
     */
    now: function(done) {
      var self = this;
      self._pipe.flush(self._get2(done.bind(self)));
      self._pipe = null;
    },

    /**
     * Keep retrying until resource is successfully fetched or maximum number of
     * retries exceeds.
     * 
     * @param {String|Object} resource The resource to bring.
     * @return {Proceed} `this` for chaining.
     */
    _repeat: function(resource, done) {
      var self = this,
          retry = (resource.opts && resource.opts.retry) || self.opts.retry;

      var resources = [], i;
      for (i = 0; i < retry; i++) {
        resources.push(resource);
      }

      var pipe = self._mkpipe(self._send, resources, 1, false);
      pipe.flush(self._measure(self._get1(done)));

      return self;
    },

    /**
     * Proceed given resource.
     * 
     * @param {String|Object} resource The resource to bring.
     * @param {Function} done The callback which gets called when the resource is
     *                        brought. It takes 2 arguments: error and response.
     */
    _send: function (resource, done) {
      var self = this;
      self._cbs && self._cbs.call(self.opts.cxt || self, resource, done);
      return self;
    },

    /**
     * Create and return new pipe from given parameters
     */
    _mkpipe: function(fn, resources, concurrency, addWeights) {
      var self = this, 
          pipe = new Pipe(concurrency),
          fill = pipe.fill.bind(pipe, fn, self);

      // single string or object
      if (!isArray(resources)) { 
        resources = [resources];
      } 

      // array - collection of string or object resources
      resources.forEach(function(resource) {
        var opts;
        if (isString(resource)) {
          // object - single url
          fill({url: resource});
        } else {
          // object - resource settings (containing url and opts)
          opts = resource.opts;
          fill(resource);
        }
        if (addWeights) {
          self._w += (opts && opts.weight) || self.opts.weight; // weight == 1 if not given
        }
      });

      return pipe;
    },

    /**
     * Schedule next task to run.
     */
    _get1: function(parentDone) {
      var self = this;
      return function(err, resource, next) {
        if (!err) {
          parentDone && parentDone(null, resource);
        } else {
          if (this.count() === 1) {
            parentDone && parentDone("error", resource);
          } else {
            next();
          }
        }
      };
    },

    /**
     * Schedule next task to run.
     */
    _get2: function(parentDone) {
      var self = this,
          result = [];
      return function(err, resource, next) {
        if (!err) {
          result.push(resource);
        } else {
          result.push(null);
        }
        if (this.count() === 1) {
          parentDone && parentDone(null, result);
        } else {
          next();
        }
      };
    },

    /**
     * Measure current progress.
     */
    _measure: function(get1) {
      var self = this;
      return function(err, resource, next) {
        var opts = resource.opts,
            retry = (opts && opts.retry) || self.opts.retry,
            weight = (opts && opts.weight) || self.opts.weight,
            increment = (err ? 1 : this.count()) / retry * weight / self._w;
        self._p += self._s * increment;
        self._cbp.call(self.opts.cxt || self, self._p, increment);
        return get1.apply(this, arguments);
      };
    },

    /**
     * Adjust the remaining progress on success.
     */
    _adjust: function(get1, resources) {
      var self = this;
      return function(err, resource, next) {
        var count = this.count(),
            len = resources.length,
            remainingWeight = 0,
            opts, i;
        if (!err) {
          for (i = len - 1; i > 0; i--) {
            if (i <= len - count) {
              break;
            }
            opts = resources[i].opts;
            remainingWeight += (opts && opts.weight) || self.opts.weight;
          }
          self._p += self._s * remainingWeight / self._w;
          self._cbp.call(self.opts.cxt || self, self._p, remainingWeight / self._w);
        }
        return get1.apply(this, arguments);
      };
    }

  };


}());
