ZIP_NAME := extension.zip
RUNTIME_PATHS := manifest.json index.html assets/css assets/emojis assets/icons assets/twemoji-init.js src LICENSE README.md

.PHONY: all verify package clean

all: package

verify:
	npm run check

package: verify clean
	zip -r "$(ZIP_NAME)" $(RUNTIME_PATHS) \
		-x "*/.DS_Store" "src/libs/*.map"

clean:
	rm -f "$(ZIP_NAME)"
