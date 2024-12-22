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

- Copy file `docker-compose.override.yml` in this repo to folder `config` in `overleaf/toolkit` repo.
> [!NOTE]
> This is a must, because the script `./bin/up` only support for `sharelatex/sharelatex` docker images.
> We must override default sharelatex image.

- Start the server as the doc
```bash
./bin/up -d
```

> [!CAUTION]
> As I built this image for production ready server, it is very large and cost almost 8gb.
> Be sure to have enough disk space when pulling it.

## Credits
- More information on [Overleaf toolkit](https://github.com/overleaf/toolkit).
- Visit [Server Pro](https://github.com/overleaf/overleaf/wiki/Getting-Server-Pro) for better 
support from Overleaf team.
- The image I built based on main [Overleaf](https://github.com/overleaf/overleaf) repo.
- You can use my 'docker-compose.yaml' file for easier setup. Hosting server without TLS should 
comment out "nginx" service and map the port for service "overleaf". Change the env variables to match
your preference.
- 'docker-stack.yaml' file is only use for Docker Swarm mode. Be sure to understand the configuration
before deploying.
