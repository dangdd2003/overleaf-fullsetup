# overleaf/clsi

A web api for compiling LaTeX documents in the cloud

The Common LaTeX Service Interface (CLSI) provides a RESTful interface to traditional LaTeX tools (or, more generally, any command line tool for composing marked-up documents into a display format such as PDF or HTML). The CLSI listens on the following ports by default:

- TCP/3013 - the RESTful interface
- TCP/3048 - reports load information
- TCP/3049 - HTTP interface to control the CLSI service

These defaults can be modified in `config/settings.defaults.cjs`.

The provided `Dockerfile` builds a Docker image which has the Docker command line tools installed. The configuration in `docker-compose-config.yml` mounts the Docker socket, in order that the CLSI container can talk to the Docker host it is running in. This allows it to spin up `sibling containers` running an image with a TeX distribution installed to perform the actual compiles.

The CLSI can be configured through the following environment variables:

- `ALLOWED_COMPILE_GROUPS` - Space separated list of allowed compile groups
- `ALLOWED_IMAGES` - Space separated list of allowed Docker TeX Live images
- `CATCH_ERRORS` - Set to `true` to log uncaught exceptions
- `COMPILE_GROUP_DOCKER_CONFIGS` - JSON string of Docker configs for compile groups
- `SANDBOXED_COMPILES` - Set to true to use sibling containers
- `SANDBOXED_COMPILES_HOST_DIR_COMPILES` - Working directory for LaTeX compiles
- `SANDBOXED_COMPILES_HOST_DIR_OUTPUT` - Output directory for LaTeX compiles
- `COMPILE_SIZE_LIMIT` - Sets the body-parser [limit](https://github.com/expressjs/body-parser#limit)
- `DOCKER_RUNTIME` -
- `FILESTORE_DOMAIN_OVERRIDE` - The url for the filestore service e.g.`http://$FILESTORE_HOST:3009`
- `FILESTORE_PARALLEL_FILE_DOWNLOADS` - Number of parallel file downloads
- `LISTEN_ADDRESS` - The address for the RESTful service to listen on. Set to `0.0.0.0` to listen on all network interfaces
- `PROCESS_LIFE_SPAN_LIMIT_MS` - Process life span limit in milliseconds
- `SMOKE_TEST` - Whether to run smoke tests
- `TEXLIVE_IMAGE` - The TeX Live Docker image to use for sibling containers, e.g. `us-east1-docker.pkg.dev/overleaf-ops/ol-docker/texlive-full:2026.1`
- `TEX_LIVE_IMAGE_NAME_OVERRIDE` - The name of the registry for the Docker image e.g. `us-east1-docker.pkg.dev/overleaf-ops/ol-docker`
- `TEXLIVE_IMAGE_USER` - When using sibling containers, the user to run as in the TeX Live image. Defaults to `tex`
- `TEXLIVE_OPENOUT_ANY` - Sets the `openout_any` environment variable for TeX Live (see the `\openout` primitive [documentation](http://tug.org/texinfohtml/web2c.html#tex-invocation))

Further environment variables configure the [metrics module](https://github.com/overleaf/metrics-module)

## Extended CE: Sandboxed TeX Live Compiles

This repository can run LaTeX compiles in isolated sibling Docker containers.
The main Overleaf container sends the compile request to CLSI; CLSI starts or
reuses a container with the selected TeX Live image, collects the PDF and logs,
and returns them to the editor. Compile containers run with dropped capabilities,
`no-new-privileges`, and a restricted seccomp profile.

### Upstream CE comparison

Upstream Overleaf CE does not provide sandboxed compiles. Its documented CE
baseline runs LaTeX with the privileges of the application container. This
extension adds the optional sibling-container runner to CE. See the [official
CE and Server Pro comparison](https://docs.overleaf.com/on-premises/welcome/server-pro-vs.-community-edition).

### Configuration

Enable the runner and select the default TeX Live image in `variable.env`:

| Environment variable                   | Default in this repository          | Purpose                                                                       |
| :------------------------------------- | :---------------------------------- | :---------------------------------------------------------------------------- |
| `SANDBOXED_COMPILES`                   | `false`                             | Run compile jobs in sibling containers.                                       |
| `TEX_LIVE_DOCKER_IMAGE`                | `dangdoan2003/texlive-full:2026`    | Default compile image.                                                        |
| `ALL_TEX_LIVE_DOCKER_IMAGES`           | 2026, 2025, 2024, 2023, 2022 images | Images users can select.                                                      |
| `ALL_TEX_LIVE_DOCKER_IMAGE_NAMES`      | `2026 (Latest),2025,2024,2023,2022` | Display names in the same order as the image list.                            |
| `TEX_LIVE_AUTO_PULL_ENABLED`           | `false`                             | Pull configured images automatically when missing.                            |
| `SANDBOXED_COMPILES_HOST_DIR_COMPILES` | detected                            | Host-visible compile directory; set if automatic volume-path detection fails. |
| `SANDBOXED_COMPILES_HOST_DIR_OUTPUT`   | detected                            | Host-visible output directory; set if automatic volume-path detection fails.  |

The CLSI container needs access to the Docker socket to start sibling
containers. Compile and output directories must be available through the same
Docker volume and mapped to their host-visible paths when auto-detection is
not sufficient. The root [New Features Reference](../../../README.md#8-tex-live-compiles--sandbox)
shows the full image list and deployment configuration.

### Developer design

`CompileManager` sends the selected command, image, and compile group to
`DockerRunner`. The runner validates the image against the configured allowlist,
maps the existing compile, output, or cache directory into `/compile`, then
starts or reuses a sibling container. Compile inputs and outputs remain in
CLSI's existing disk directories; CLSI does not add MongoDB collections.

Containers are named by project and a fingerprint of their image and run
options, so matching jobs can reuse one safely. Runs sharing a container are
queued; successful runs prune stopped sibling containers, and an idle monitor
removes old ones. Read-only jobs such as SyncTeX and word count get a read-only
bind mount. The sandbox defaults to no network, no Linux capabilities,
`no-new-privileges`, and the configured seccomp profile. The compile process
runs as the configured TeX image user (normally `tex`); Overleaf account roles
are not passed into the container.

## Installation

The CLSI can be installed and set up as part of the entire [Overleaf stack](https://github.com/overleaf/overleaf) (complete with front end editor and document storage), or it can be run as a standalone service. To run is as a standalone service, first checkout this repository:

```shell
git clone git@github.com:overleaf/overleaf.git
```

Then build the Docker image:

```shell
docker build . -t overleaf/clsi -f services/clsi/Dockerfile
```

Then pull the TeX Live image:

```shell
docker pull texlive/texlive
```

Then start the Docker container:

```shell
docker run --rm \
  -p 127.0.0.1:3013:3013 \
  -e LISTEN_ADDRESS=0.0.0.0 \
  -e SANDBOXED_COMPILES=true \
  -e TEXLIVE_IMAGE=texlive/texlive \
  -e TEXLIVE_IMAGE_USER=root \
  -e SANDBOXED_COMPILES_HOST_DIR_COMPILES="$PWD/compiles" \
  -v "$PWD/compiles:/overleaf/services/clsi/compiles" \
  -v "$PWD/cache:/overleaf/services/clsi/cache" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  --name clsi \
  overleaf/clsi
```

Note: if you're running the CLSI in macOS you may need to use `-v /var/run/docker.sock.raw:/var/run/docker.sock` instead.

The CLSI should then be running at <http://localhost:3013>

# Important note for Linux users

The Node application runs as user `node` in the CLSI, which has uid `1000`. As a consequence of this, the `compiles` folder gets created on your host with `uid` and `gid` set to `1000`.

```shell
ls -lnd compiles
```

> `drwxr-xr-x 2 1000 1000 4096 Mar 19 12:41 compiles`

If there is a user/group on your host which also happens to have `uid` / `gid` `1000` then that user/group will have ownership of the compiles folder on your host.

LaTeX runs in the sibling containers as the user specified in the `TEXLIVE_IMAGE_USER` environment variable. In the example above this is set to `root`, which has uid `0`. This creates a problem with the above permissions, as the root user does not have permission to write to subfolders of `compiles`.

A quick fix is to give the `root` group ownership and read write permissions to `compiles`, with `setgid` set so that new subfolders also inherit this ownership:

```shell
sudo chown -R 1000:root compiles
sudo chmod -R g+w compiles
sudo chmod g+s compiles
```

Another solution is to create a `overleaf` group and add both `root` and the user with `uid` `1000` to it. If the host does not have a user with that `uid`, you will need to create one first.

```shell
sudo useradd --uid 1000 host-node-user # If required
sudo groupadd overleaf
sudo usermod -a -G overleaf root
sudo usermod -a -G overleaf $(id -nu 1000)
sudo chown -R 1000:overleaf compiles
sudo chmod -R g+w compiles
sudo chmod g+s compiles
```

This is a facet of the way docker works on Linux. See this [upstream issue](https://github.com/moby/moby/issues/7198)

## API

The CLSI is based on a JSON API.

#### Example Request

(Note that valid JSON should not contain any comments like the example below).

    POST /project/<project-id>/compile

```json5
{
  compile: {
    options: {
      // Which compiler to use. Can be latex, pdflatex, xelatex or lualatex
      compiler: "lualatex",
      // How many seconds to wait before killing the process. Default is 60.
      timeout: 40,
    },
    // The main file to run LaTeX on
    rootResourcePath: "main.tex",
    // An array of files to include in the compilation. May have either the content
    // passed directly, or a URL where it can be downloaded.
    resources: [
      {
        path: "main.tex",
        content: "\\documentclass{article}\n\\begin{document}\nHello World\n\\end{document}",
      },
      // ,{
      //     "path": "image.png",
      //     "url": "www.example.com/image.png",
      //     "modified": 123456789 // Unix time since epoch
      // }
    ],
  },
}
```

With `curl`, if you place the above JSON in a file called `data.json`, the request would look like this:

```shell
curl -X POST -H 'Content-Type: application/json' -d @data.json http://localhost:3013/project/<id>/compile
```

You can specify any project-id in the URL, and the files and LaTeX environment will be persisted between requests.
URLs will be downloaded and cached until provided with a more recent modified date.

#### Example Response

```json
{
  "compile": {
    "status": "success",
    "outputFiles": [
      {
        "type": "pdf",
        "url": "http://localhost:3013/project/<project-id>/output/output.pdf"
      },
      {
        "type": "log",
        "url": "http://localhost:3013/project/<project-id>/output/output.log"
      }
    ]
  }
}
```

## License

The code in this repository is released under the GNU AFFERO GENERAL PUBLIC LICENSE, version 3. A copy can be found in the `LICENSE` file.

Copyright (c) Overleaf, 2014-2021.
