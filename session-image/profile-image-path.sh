# Puts the image's PATH back after /etc/profile has replaced it.
#
# Debian's /etc/profile assigns PATH outright a few lines above this, dropping
# every directory the image added: the agent's own ~/.local/bin and the
# per-language install directories Go, Cargo and Composer put binaries in.
# /etc/profile.d is sourced after that assignment, so this is the one place a
# login shell -- `bash -lc`, which is what the command surface and the agent's
# own shell tools use -- can be given them back.
#
# The list is deliberately not repeated here. /etc/boxes/image-path is a
# snapshot of the image's own PATH taken at build time, so the Dockerfile
# stays the single place a directory is named and the two cannot drift.
if [ -r /etc/boxes/image-path ]; then
  . /etc/boxes/image-path

  # The image's directories first, then whatever /etc/profile added that the
  # image did not already list, in its order. An empty element is dropped
  # rather than carried through: in PATH it means the working directory.
  boxes_path="${BOXES_IMAGE_PATH}"
  boxes_ifs="${IFS}"
  IFS=:
  for boxes_dir in ${PATH}; do
    [ -n "${boxes_dir}" ] || continue
    case ":${BOXES_IMAGE_PATH}:" in
      *":${boxes_dir}:"*) ;;
      *) boxes_path="${boxes_path}:${boxes_dir}" ;;
    esac
  done
  IFS="${boxes_ifs}"

  PATH="${boxes_path}"
  export PATH
  unset BOXES_IMAGE_PATH boxes_path boxes_ifs boxes_dir
fi
