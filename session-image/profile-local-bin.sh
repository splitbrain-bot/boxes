# Keeps the agent's own tool directory on PATH for a login shell.
#
# /etc/profile has replaced PATH wholesale a few lines above this, dropping
# what the image set, and /etc/profile.d is sourced after it -- so this is the
# one place a login shell can be given the directory back.
case ":${PATH}:" in
  *":${HOME:-/home/agent}/.local/bin:"*) ;;
  *)
    PATH="${HOME:-/home/agent}/.local/bin:${PATH}"
    export PATH
    ;;
esac
