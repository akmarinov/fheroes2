/***************************************************************************
 *   fheroes2: https://github.com/ihhub/fheroes2                           *
 *   Copyright (C) 2026                                                    *
 *                                                                         *
 *   This program is free software; you can redistribute it and/or modify  *
 *   it under the terms of the GNU General Public License as published by  *
 *   the Free Software Foundation; either version 2 of the License, or     *
 *   (at your option) any later version.                                   *
 *                                                                         *
 *   This program is distributed in the hope that it will be useful,       *
 *   but WITHOUT ANY WARRANTY; without even the implied warranty of        *
 *   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the         *
 *   GNU General Public License for more details.                          *
 *                                                                         *
 *   You should have received a copy of the GNU General Public License     *
 *   along with this program; if not, write to the                         *
 *   Free Software Foundation, Inc.,                                       *
 *   59 Temple Place - Suite 330, Boston, MA  02111-1307, USA.             *
 ***************************************************************************/

#include "lazy_media.h"

#if defined( __EMSCRIPTEN__ )
#include <filesystem>
#include <system_error>

#include <emscripten.h>
#endif

namespace
{
#if defined( __EMSCRIPTEN__ )
    // Asks the page for the bytes of one animation file, and gives back the memory of the one it handed
    // over before that. The page keeps the game's films in the storage area of the browser, which
    // survives the tab being closed, while the file system of the engine is memory, which does not: at
    // start-up only the aggregates and the maps are read into it, because the animation folder is the
    // largest part of the game and a phone allows a page only a limited amount of memory.
    //
    // The answer arrives asynchronously, and waiting for it suspends this function: the build unwinds the
    // stack while it waits and rewinds it afterwards. That is also why the bytes are written into the
    // file system here, inside the suspension, and the answer is only a number: a JavaScript object which
    // had to outlive the wait could be reclaimed by the browser in the meantime, and this cannot decide
    // when a page stops referring to something.
    //
    // The file being given up is truncated rather than removed, which restores the empty placeholder the
    // page created for it. Removing it would take the name out of the listing of the directory, and the
    // next lookup of the same film - the same title played twice, or a video which is skipped and then
    // replayed - would then report a file which does not exist instead of offering to fetch it again.
    EM_ASYNC_JS( int, swapAnimation, ( const char * path, const char * givenUp ), {
        // clang-format off
        const provider = globalThis.fheroes2FetchAnimation;

        if ( typeof provider !== "function" ) {
            return 0;
        }

        let bytes;

        try {
            // The page hands over a view of the bytes it read, which is the only shape in which the
            // buffer itself - rather than a copy of it - can be handed to the file system below.
            bytes = await provider( UTF8ToString( path ) );
        }
        catch ( error ) {
            console.error( "fheroes2: the bytes of an animation file could not be read", path, error );

            return 0;
        }

        if ( !bytes || bytes.byteLength < 1 ) {
            return 0;
        }

        if ( givenUp ) {
            try {
                FS.truncate( UTF8ToString( givenUp ), 0 );
            }
            catch ( error ) {
                // A file the browser will not shrink keeps its own memory; the peak is then two films
                // instead of one, which is still nothing like the sum of the folder.
            }
        }

        // Handing the buffer over with canOwn lets the file system adopt it at its own size instead of
        // growing an empty file by doubling, which for the largest film of the game would mean copying
        // it into and out of several capacities at once. The buffer is not a view of the memory of the
        // engine - it came out of the storage of the browser - so the adoption is real.
        FS.writeFile( UTF8ToString( path ), bytes, { canOwn: true } );

        return bytes.byteLength;
        // clang-format on
    } )

    // The film whose bytes are in memory right now, empty if none is. It is what the next fetch is told
    // to give back: videos are watched one at a time, and whoever watches one copies the whole of it into
    // memory of its own before the file is needed again, so nothing is lost by handing the bytes over -
    // but only if the page knows which ones to ask for.
    std::string & currentAnimation()
    {
        static std::string path;

        return path;
    }
#endif
}
#if defined( __EMSCRIPTEN__ )
/*
 * Whether this engine can come back to the page for the bytes of a film.
 *
 * The launcher creates an empty file for every film it keeps out of memory, and an empty file is what this
 * engine reads as an offer to fetch it. A launcher paired with an engine which cannot fetch - the browser
 * kept the binary of an older build while the page is new, which is exactly what a long-lived cache on the
 * wasm binary invites - would then hand that engine a film of no bytes at all, and the video layer reports
 * a file of fewer than 56 bytes as corrupted, throwing instead of ignoring it. So the launcher asks before
 * it stages anything: the presence of this symbol is the answer, and a build without it is treated as one
 * which must be given real files or none. The keepalive attribute is what puts it in the exports of the
 * module: listing it under EXPORTED_FUNCTIONS instead would replace the default list of the link step,
 * of which `main` is a part.
 */
extern "C" EMSCRIPTEN_KEEPALIVE int System_CanFetchAnimation()
{
    return 1;
}
#endif

bool System::LoadAnimationFile( const std::string & filePath )
{
#if !defined( __EMSCRIPTEN__ )
    (void)filePath;

    return true;
#else
    if ( filePath.empty() ) {
        return true;
    }

    /*
     * An empty file is the sign that the bytes of this film are held by the page rather than here, which
     * is how the page marks the films it chose not to bring into memory at start-up. Any other size means
     * the bytes are already where the engine can read them - the page may well write some of the films in
     * full, either because it is older than this engine or because it judged the file small enough to
     * keep - and asking for such a file would copy it a second time over the copy which is already there.
     */
    std::error_code error;

    if ( auto size = std::filesystem::file_size( filePath, error ); error || size != 0 ) {
        return true;
    }

    std::string & current = currentAnimation();

    const int size = swapAnimation( filePath.c_str(), current.empty() ? nullptr : current.c_str() );

    if ( size < 1 ) {
        // The page has no bytes for this film: it was never imported, or the storage of the browser could
        // not be read, or the page is older than this engine. The film which is held was not given up in
        // that case - the page only shrinks it once it has something to put in its place - so the record
        // of it stays as it is, to be handed over with the next film that is asked for. The caller treats
        // this answer as a file which is not there, which is also what the game does for a video of an
        // expansion the player does not own.
        return false;
    }

    current = filePath;

    return true;
#endif
}
