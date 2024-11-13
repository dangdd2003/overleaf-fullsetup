# How to use updated image?

- Clone the `overleaf/toolkit` repo.

```bash
git clone https://github.com/overleaf/toolkit.git ./overleaf-toolkit
```

- Init the configuration.

```bash
cd ./overleaf-toolkit
./bin/init
```

- Change value of environment variables in file `./config/overleaf.rc`.

```config
...
OVERLEAF_IMAGE_NAME=<registry>/<username>/sharelatex:latest-full-setup
...
```

> [!NOTE]
> `registry` is where to push the image (e.g. _docker.io_ or _ghcr.io_),
> `username` is username on the registry. For _docker.io_, omit `registry` is ok.

For example:

```config
# Use github container registry
OVERLEAF_IMAGE_NAME=ghcr.io/dangdd2003/sharelatex:latest-full-setup
# Use docker hub
OVERLEAF_IMAGE_NAME=dangdoan2003/sharelatex:latest-full-setup
```

- Look for this file `lib/shared-function.sh`.
- In line 88 (as the latest commits), remove `$version`.

Before:

```sh
...
export IMAGE="$image_name:$version"
...
```

After:

```sh
...
export IMAGE="$image_name"
...
```

> [!NOTE]
> As we don't want to use images pulled by default from sharelatex (overleaf).
> The builtin script will check for version in file `config/version`, so
> just leave it untouched and only remove `$version` in `lib/shared-function.sh`.

- Configure another variables as needed and start the server.

```bash
./bin/up -d
```

- More information on [Overleaf toolkit](https://github.com/overleaf/toolkit).
