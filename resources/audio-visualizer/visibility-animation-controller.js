;(function (root) {
  function createVisibilityAnimationController(isHidden, stop, resume) {
    return {
      onVisibilityChange: function () {
        if (isHidden()) stop()
        else resume()
      }
    }
  }
  root.createVisibilityAnimationController = createVisibilityAnimationController
  if (typeof module !== 'undefined') module.exports = { createVisibilityAnimationController }
})(typeof window !== 'undefined' ? window : globalThis)
