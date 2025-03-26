ZIP_NAME=extension.zip
IGNORE_FILES=.git/\* node_modules/\* Makefile makefile

all:

	rm -f $(ZIP_NAME)

	find . -name ".DS_Store" -type f -delete

	zip -r $(ZIP_NAME) . -x $(IGNORE_FILES)
