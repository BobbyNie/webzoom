// lanpack is a build tool, not an installer or privileged action.
package main

import (
	"fmt"
	"os"
	"webzoom/internal/lansetup"
)

func main() {
	if len(os.Args) != 4 {
		fmt.Fprintln(os.Stderr, "usage: lanpack stub.exe payload.zip target.exe")
		os.Exit(2)
	}
	if err := lansetup.AppendBundle(os.Args[1], os.Args[2], os.Args[3]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
