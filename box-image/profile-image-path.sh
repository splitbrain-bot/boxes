# Login shell snippet that puts the image's PATH back in front.
#
# An /etc/profile that assigns PATH outright drops the directories the image
# added. /etc/profile.d runs after that assignment. /etc/boxes/image-path holds
# the image's PATH as the Dockerfile left it.
if [ -r /etc/boxes/image-path ]; then
  . /etc/boxes/image-path

  # The image's directories first, then any others in their order. An empty
  # element is dropped, because in PATH it means the working directory.
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
