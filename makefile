ZIP_NAME=extension.zip
IGNORE_FILES=.git/\* node_modules/\* Makefile makefile

all:

	rm -f $(ZIP_NAME)

	find . -name ".DS_Store" -type f -delete
	find . -name "screenshot.png" -type f -delete
	find . -name ".vscode" -type d -delete

	zip -r $(ZIP_NAME) . -x $(IGNORE_FILES)
