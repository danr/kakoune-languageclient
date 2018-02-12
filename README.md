# kakoune-languageclient

Work in progress

![](https://motherboard-images.vice.com/content-images/contentimage/26327/1444070256569233.gif)

```
yarn
yarn run test
yarn run example <kak-session>
yarn run main <kak-session> <server command>
```

`yarn run main` needs two arguments:

* <kak session>
* <server command>

Example:

    yarn run 4782 javascript-typescript-stdio

which can be installed with

    yarn global add javascript-typescript-langserver

Add `-d` for debug output after the server command.
